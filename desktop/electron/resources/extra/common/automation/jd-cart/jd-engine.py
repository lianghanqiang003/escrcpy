#!/usr/bin/env python3
"""JD Android link -> coupon claim / add-to-cart, using local ADB and local OCR.

No credentials, browser cookies, affiliate conversion or checkout API are used.
Only explicit, visible, allowlisted buttons are tapped. Uncertain results pause.
"""
from __future__ import annotations

import csv
import hashlib
import html
import http.cookiejar
import io
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODEL_DIR = Path(os.environ.get("JD_TESSDATA", str(ROOT / "tessdata")))
RUNS_DIR = Path(os.environ.get("JD_RUNS_DIR", str(ROOT / "runs")))
OCR_HELPER = Path(os.environ.get("JD_OCR_HELPER", str(ROOT / "ocr-preprocess")))
JD_PACKAGE = "com.jingdong.app.mall"
ADD = {"加入购物车", "加购物车"}
CLAIM = {"立即领取", "马上领取", "点击领取", "一键领取", "领取优惠券", "领取"}
ADD_OK = ("加入购物车成功", "已成功加入购物车", "已加入购物车", "已加入购物袋", "加购成功", "添加购物车成功")
COUPON_OK = ("领取成功", "领券成功", "已领取", "已领过", "您已领取", "已经领取")
COUPON_BAD = ("已抢光", "已领完", "活动已结束", "优惠券已过期", "优惠券不存在", "不符合领取条件", "未达到领取条件", "今日已抢完", "来晚了", "活动已下线", "优惠券不可用")
VERIFY = ("安全验证", "请完成验证", "拖动滑块", "拖动下方滑块", "身份验证", "请依次点击", "请完成下方验证")


def normalize(text: str) -> str:
    return re.sub(r"[\s\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]+", "", text or "")


def allowed_url(url: str) -> bool:
    try:
        p = urllib.parse.urlsplit(url)
        host = (p.hostname or "").lower()
        if p.username or p.password or any(ord(c) < 32 for c in url):
            return False
        if p.scheme.lower() in {"https", "http"}:
            return (host == "jd.com" or host.endswith(".jd.com") or host == "3.cn" or host.endswith(".3.cn")) and p.port in (None, 80, 443)
        return p.scheme.lower() in {"openapp.jdmobile", "openjd"}
    except ValueError:
        return False


def link_kind(url: str) -> str:
    p = urllib.parse.urlsplit(url)
    if (p.hostname or "").lower() in {"coupon.m.jd.com", "coupon.jd.com", "coupon.jd.hk"}:
        return "coupon"
    if (p.hostname or "").lower() in {"item.jd.com", "item.m.jd.com"}:
        return "product"
    # Affiliate short links may resolve to goods OR coupons. Inspect the landing UI.
    return "auto"


def sku_from_url(url: str) -> str | None:
    p = urllib.parse.urlsplit(url)
    if (p.hostname or '').lower() not in {'item.jd.com', 'item.m.jd.com'}:
        return None
    m = re.search(r'/(?:product/)?(\d+)\.html', p.path)
    return m.group(1) if m else None


def find_tesseract():
    return os.environ.get('JD_TESSERACT') or shutil.which('tesseract')


def extract_links(text: str) -> tuple[list[dict], list[str]]:
    """Accept plain lines, copied chat messages and Markdown. Keep attribution intact."""
    # A Markdown label may itself contain an escaped URL. Only execute its destination.
    text = re.sub(r"\[[^\]]*\]\(((?:https?://|openapp\.jdmobile://|openjd://)[^\s<>]*?)\)", r"\1", text, flags=re.I)
    pattern = r"(?:https?://|openapp\.jdmobile://|openjd://)[^\s<>()\[\]\"'\u3000]+"
    links, rejected, seen = [], [], set()
    for match in re.finditer(pattern, text, re.I):
        url = match.group().rstrip("),，。；;！!？?】）")
        if url in seen:
            continue
        seen.add(url)
        if not allowed_url(url):
            rejected.append(url)
            continue
        links.append({"id": hashlib.sha256(url.encode()).hexdigest()[:16], "url": url,
                      "kind": link_kind(url), "status": "pending", "message": "等待处理"})
    return links, rejected


def expand_short_link(url: str) -> str:
    """Follow JD's public HTTP/JS navigation; never invent or strip tracking fields.

Some JD app versions route u.jd.com straight to a search promotion page. The public
short-link page navigates to a tracked item URL instead. Read only that literal
navigation URL (not arbitrary JavaScript), and retain the full final query string.
"""
    if (urllib.parse.urlsplit(url).hostname or '').lower() != 'u.jd.com':
        return url
    class JDRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            if not allowed_url(newurl) or urllib.parse.urlsplit(newurl).scheme not in {'http', 'https'}:
                raise ValueError('短链跳转到了非京东地址，请手动核实')
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    opener = urllib.request.build_opener(JDRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    current = url
    for _ in range(3):
        req = urllib.request.Request(current, headers={'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36'})
        with opener.open(req, timeout=12) as response:
            current = response.url
            body = response.read(300_000).decode('utf-8', errors='replace')
        if link_kind(current) in {'product', 'coupon'}:
            return current
        match = re.search(r"\bvar\s+hrl\s*=\s*(['\"])([^'\"]+)\1", body)
        if not match:
            break
        current = html.unescape(match.group(2))
        if not allowed_url(current) or urllib.parse.urlsplit(current).scheme not in {'http', 'https'}:
            raise ValueError('短链包含非京东跳转地址，请手动核实')
    raise RuntimeError('未解析出短链对应的商品／优惠券。请提供完整推广链接，或在手机打开目标商品后继续。')


@dataclass
class Node:
    text: str
    bounds: tuple[int, int, int, int]
    package: str = ""
    source: str = "xml"
    enabled: bool = True
    actionable: bool = True
    resource_id: str = ""
    class_name: str = ""
    @property
    def center(self):
        x1, y1, x2, y2 = self.bounds
        return ((x1 + x2) // 2, (y1 + y2) // 2)


@dataclass
class Screen:
    nodes: list[Node] = field(default_factory=list)
    packages: set[str] = field(default_factory=set)
    screenshot: Path | None = None
    width: int = 1080
    height: int = 2400
    @property
    def text(self):
        return "\n".join(n.text for n in self.nodes)
    def contains(self, values):
        return any(normalize(s) in normalize(self.text) for s in values)
    def exact(self, values):
        choices = [n for n in self.nodes if n.enabled and n.actionable and normalize(n.text) in values
                   and n.bounds[2] > n.bounds[0] and n.bounds[3] > n.bounds[1]]
        choices = [n for n in choices if n.bounds[3]-n.bounds[1] < self.height * 0.22
                   and (normalize(n.text) not in ADD or n.center[1] > self.height * 0.45)
                   and (normalize(n.text) not in CLAIM or n.center[1] > self.height * 0.20)]
        # One control can appear both as text and content-description; XML wins over OCR.
        dedup = []
        for n in sorted(choices, key=lambda n: n.source != "xml"):
            if not any(abs(n.center[0]-old.center[0]) < 90 and abs(n.center[1]-old.center[1]) < 55 for old in dedup):
                dedup.append(n)
        return dedup
    def cart_count(self):
        for node in self.nodes:
            match = re.fullmatch(r'(?:已加购|购物车[,，、：:]?)(\d+)(?:件|个)?', normalize(node.text))
            if match:
                return int(match.group(1))
        return None


def parse_xml(xml: str) -> Screen:
    start = xml.find("<?xml")
    if start < 0:
        start = xml.find("<hierarchy")
    if start < 0:
        raise ValueError("未读到安卓界面 XML")
    root = ET.fromstring(xml[start:])
    screen = Screen()
    all_bounds = [tuple(map(int, m.groups())) for e in root.iter('node')
                  if (m := re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", e.get('bounds', '')))]
    if all_bounds:
        screen.width = max(b[2] for b in all_bounds) or 1080
        screen.height = max(b[3] for b in all_bounds) or 2400
    parent_map = {child: parent for parent in root.iter() for child in parent}
    for e in root.iter("node"):
        pkg = e.get("package", "")
        screen.packages.add(pkg)
        b = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", e.get("bounds", ""))
        if not b:
            continue
        ancestor = e
        actionable = False
        while ancestor is not None:
            if ancestor.get("clickable") == "true" or ancestor.get("class") == "android.widget.Button":
                actionable = True
                break
            ancestor = parent_map.get(ancestor)
        for label in dict.fromkeys([e.get("text", ""), e.get("content-desc", "")]):
            if label:
                screen.nodes.append(Node(label, tuple(map(int, b.groups())), pkg, enabled=e.get("enabled") != "false", actionable=actionable, resource_id=e.get("resource-id", ""), class_name=e.get("class", "")))
        if not e.get("text") and not e.get("content-desc") and (e.get("class", "").endswith("EditText") or "search" in e.get("resource-id", "").lower()):
            screen.nodes.append(Node("", tuple(map(int, b.groups())), pkg, enabled=e.get("enabled") != "false", actionable=actionable, resource_id=e.get("resource-id", ""), class_name=e.get("class", "")))
    return screen


class Adb:
    def __init__(self, serial: str = "", run_dir: Path | None = None, binary: str | None = None):
        self.binary = binary or os.environ.get("ADB") or shutil.which("adb")
        if not self.binary:
            raise RuntimeError("找不到 adb，请安装 Android Platform Tools 或 Escrcpy")
        self.serial = serial
        self.run_dir = run_dir
        self.remote_xml = f"/sdcard/jd_batch_{os.getpid()}.xml"
        self.tesseract = find_tesseract()
        self.ocr_enabled = bool(self.tesseract and (MODEL_DIR / 'chi_sim.traineddata').is_file())

    def run(self, *args: str, timeout=20, binary=False):
        if getattr(self, "stop_event", None) and self.stop_event.is_set():
            raise Stopped()
        cmd = [self.binary] + (["-s", self.serial] if self.serial else []) + list(args)
        # Only read/setup operations may be retried. Never replay a tap.
        safe_retry = args[0] == 'exec-out' or (args[0] == 'shell' and (
            args[1] == 'input keyevent KEYCODE_WAKEUP' or not re.search(r'\binput (tap|swipe|text|keyevent)\b', args[1])))
        for attempt in range(2):
            try:
                r = subprocess.run(cmd, capture_output=True, timeout=timeout)
            except subprocess.TimeoutExpired as e:
                raise RuntimeError(f"ADB 操作超时（{args[0]}），请检查手机和无线连接") from e
            if not r.returncode:
                return r.stdout if binary else r.stdout.decode(errors="replace")
            error = r.stderr.decode(errors="replace")[-600:] or "ADB 执行失败"
            recoverable = any(t in error.lower() for t in ('device offline', 'error: closed', 'not found', 'no devices'))
            if attempt == 0 and safe_retry and recoverable and re.fullmatch(r'\d+\.\d+\.\d+\.\d+:\d+', self.serial):
                subprocess.run([self.binary, 'connect', self.serial], capture_output=True, timeout=10)
                time.sleep(1)
                continue
            raise RuntimeError(f"ADB {args[0]}：{error}")

    def shell(self, *args: str, timeout=20):
        # adb shell uses a remote shell; quote each argument AGAIN for that shell.
        return self.run("shell", shlex.join(args), timeout=timeout)

    def devices(self):
        rows = []
        for line in self.run("devices", "-l").splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 2:
                model = next((p[6:] for p in parts if p.startswith("model:")), "Android")
                rows.append({"serial": parts[0], "state": parts[1], "model": model})
        return rows

    def prepare(self):
        if not self.shell("pm", "path", JD_PACKAGE).strip():
            raise RuntimeError("目标手机没有安装京东 App")
        self.shell("input", "keyevent", "KEYCODE_WAKEUP")
        # Android only dismisses a non-secure keyguard; a PIN/password still requires its owner.
        self.shell("wm", "dismiss-keyguard")

    def open_link(self, url: str):
        if not allowed_url(url):
            raise ValueError("仅允许京东官方域名和京东 App 链接")
        self.shell("input", "keyevent", "KEYCODE_WAKEUP")
        output = self.shell("am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", url, "-p", JD_PACKAGE, timeout=30)
        if "Error:" in output or "unable to resolve" in output:
            raise RuntimeError("京东 App 无法直接打开这条链接，请在手机中核实链接")

    def tap(self, node: Node):
        self.shell("input", "tap", *map(str, node.center))

    def snapshot(self, use_ocr=True) -> Screen:
        self.shell("input", "keyevent", "KEYCODE_WAKEUP")
        self.shell("wm", "dismiss-keyguard")
        # Remove the previous dump first: a timed-out dump must never return a stale page.
        self.shell("rm", "-f", self.remote_xml)
        self.shell("uiautomator", "dump", "--compressed", self.remote_xml, timeout=18)
        screen = parse_xml(self.run("exec-out", "cat", self.remote_xml, timeout=10))
        if JD_PACKAGE not in screen.packages:
            return screen
        if self.run_dir:
            png = self.run_dir / "current.png"
            temp = self.run_dir / "current.tmp.png"
            temp.write_bytes(self.run("exec-out", "screencap", "-p", binary=True))
            temp.replace(png)
            screen.screenshot = png
            decisive = screen.exact(ADD | CLAIM) or screen.contains(ADD_OK + COUPON_OK + COUPON_BAD + VERIFY)
            if use_ocr and not decisive:
                screen.nodes.extend(self.ocr(png))
        return screen

    def ocr(self, png: Path) -> list[Node]:
        if not self.ocr_enabled:
            return []
        try:
            languages = 'chi_sim+eng' if (MODEL_DIR / 'eng.traineddata').is_file() else 'chi_sim'
            nodes, lines = [], {}
            images = [(str(png), 0, 0, '11')]
            helper = OCR_HELPER
            if helper.is_file():
                p = subprocess.run([str(helper), str(png), str(png) + '.ocr.png'], capture_output=True, text=True, timeout=5)
                if p.returncode == 0:
                    images.extend((x['path'], x['x'], x['y'], '6') for x in json.loads(p.stdout))
            for image_index, (path, dx, dy, mode) in enumerate(images):
                r = subprocess.run([self.tesseract, path, 'stdout', '--tessdata-dir', str(MODEL_DIR),
                                    '-l', languages, '--psm', mode, '-c', 'tessedit_create_tsv=1'], capture_output=True, text=True, timeout=12)
                if r.returncode:
                    continue
                for x in csv.DictReader(io.StringIO(r.stdout), delimiter='\t'):
                    if not x.get('text', '').strip() or float(x['conf']) < 35:
                        continue
                    left, top, width, height = (int(x[k]) for k in ['left', 'top', 'width', 'height'])
                    node = Node(x['text'], (left+dx, top+dy, left+dx+width, top+dy+height), JD_PACKAGE, 'ocr')
                    nodes.append(node)
                    lines.setdefault((image_index, x['block_num'], x['par_num'], x['line_num']), []).append(node)
            for words in lines.values():
                if len(words) > 1:
                    words.sort(key=lambda n: n.bounds[0])
                    nodes.append(Node(''.join(n.text for n in words), (min(n.bounds[0] for n in words), min(n.bounds[1] for n in words),
                        max(n.bounds[2] for n in words), max(n.bounds[3] for n in words)), JD_PACKAGE, 'ocr'))
            return nodes
        except (OSError, ValueError, subprocess.TimeoutExpired):
            self.ocr_enabled = False
            return []

    def quick_result(self, success_words: tuple[str, ...]) -> bool:
        # Catch short-lived success toasts before a full UIAutomator dump finishes.
        if not self.run_dir or not self.ocr_enabled:
            return False
        for _ in range(3):
            png = self.run_dir / "quick.png"
            png.write_bytes(self.run("exec-out", "screencap", "-p", binary=True))
            if Screen(self.ocr(png)).contains(success_words):
                return True
            time.sleep(0.25)
        return False


class Stopped(Exception):
    pass


class Controller:
    def __init__(self):
        self.lock = threading.RLock()
        self.event = threading.Event()
        self.action = ""
        self.stop_event = threading.Event()
        self.state = {"running": False, "paused": False, "message": "粘贴佣金商品链接和优惠券链接开始", "items": [], "logs": [], "run_dir": ""}
        self.worker = None
        self.adb = None

    def log(self, message):
        with self.lock:
            self.state["message"] = message
            self.state["logs"].append({"time": datetime.now().strftime("%H:%M:%S"), "message": message})
            self.state["logs"] = self.state["logs"][-200:]

    def item_update(self, item, status, message):
        with self.lock:
            item.update(status=status, message=message)
        self.log(message)
        self.save()

    def start(self, serial, items, commission_entry=""):
        with self.lock:
            if self.state["running"]:
                raise ValueError("已有任务运行中")
            devices = Adb().devices()
            if serial not in [d["serial"] for d in devices if d["state"] == "device"]:
                raise ValueError("请明确选择一台在线手机")
            if not items or len(items) > 100:
                raise ValueError("每次请输入 1–100 条链接")
            if commission_entry and not allowed_url(commission_entry):
                raise ValueError("固定佣金入口必须是京东官方链接")
            # Never trust client-supplied status, ids, or URLs.
            clean = []
            seen = set()
            for i in items:
                url = str(i.get("url", ""))
                if not allowed_url(url) or i.get("kind") not in {"auto", "coupon", "product"}:
                    raise ValueError("链接或类型无效")
                if url in seen:
                    continue
                seen.add(url)
                clean.append({"id": hashlib.sha256(url.encode()).hexdigest()[:16], "url": url, "kind": i["kind"], "status": "pending", "message": "等待处理"})
            # Coupons have priority, preserving relative order within each class.
            clean.sort(key=lambda i: i["kind"] != "coupon")
            run_dir = RUNS_DIR / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3))
            run_dir.mkdir(parents=True, mode=0o700)
            self.state = {"running": True, "paused": False, "message": "启动中", "items": clean, "logs": [], "serial": serial, "run_dir": str(run_dir), "pause_options": [], "commission_entry": commission_entry}
            self.stop_event.clear()
            self.adb = Adb(serial, run_dir)
            self.adb.stop_event = self.stop_event
            self.worker = threading.Thread(target=self.run, daemon=True)
            self.worker.start()

    def checkpoint(self):
        if self.stop_event.is_set():
            raise Stopped()

    def pause(self, message, options=("continue", "skip")):
        self.checkpoint()
        with self.lock:
            self.action = ""
            self.event.clear()
            self.state.update(paused=True, pause_options=list(options), pause_id=secrets.token_hex(8))
        self.log(message)
        self.save()
        while not self.event.wait(0.5):
            self.checkpoint()
        self.checkpoint()
        with self.lock:
            action = self.action
            self.state.update(paused=False, pause_options=[], pause_id="")
        return action

    def respond(self, action):
        with self.lock:
            if action == "stop":
                self.stop_event.set()
            elif self.state.get("paused") and action in self.state.get("pause_options", []):
                self.action = action
            else:
                raise ValueError("当前操作已过期，请等待界面刷新")
            self.event.set()

    def screen(self):
        while True:
            self.checkpoint()
            page = self.adb.snapshot()
            if JD_PACKAGE not in page.packages:
                reason = "手机未显示京东。请解锁并回到已打开的京东页面，然后点继续。"
            elif page.contains(VERIFY):
                reason = "京东要求安全验证。请在手机上完成验证，然后点继续。"
            elif page.contains(("京东登录", "登录注册", "登录后领取", "请先登录")) or (page.contains(("短信验证码登录", "账号密码登录")) and not page.exact(ADD | CLAIM)):
                reason = "请在手机上完成京东登录，然后点继续。"
            else:
                return page
            if self.pause(reason) == "skip":
                return None

    def record_evidence(self, item, page):
        if page and page.screenshot:
            filename = f"{item['id']}-{item['status']}.png"
            dest = self.adb.run_dir / filename
            shutil.copyfile(page.screenshot, dest)
            item["screenshot"] = filename

    def process(self, item):
        entry = self.state.get("commission_entry", "")
        if entry and item["kind"] != "coupon" and entry != item["url"]:
            self.log("先访问你设置的固定佣金入口")
            self.adb.open_link(entry)
            time.sleep(2)
            entry_page = self.screen()
            if entry_page is None:
                self.item_update(item, "skipped", "佣金入口未就绪，已跳过本条")
                return
            if entry_page.contains(COUPON_BAD):
                action = self.pause("固定佣金入口显示活动已结束或不可用。请核实入口后决定是否继续打开本条商品。", ("continue", "skip"))
                if action == "skip":
                    self.item_update(item, "skipped", "固定佣金入口不可用，已跳过")
                    return
            item["commission_entry_visited"] = True
        self.item_update(item, "opening", f"打开原始链接：{urllib.parse.urlsplit(item['url']).hostname or '京东 App'}")
        self.adb.open_link(item["url"])
        if (urllib.parse.urlsplit(item['url']).hostname or '').lower() == 'u.jd.com':
            self.log('正在跟随原短链的完整推广跳转，定位具体商品')
            try:
                expanded = expand_short_link(item['url'])
                item['resolved_url'] = expanded
                self.adb.open_link(expanded)
            except Exception as e:
                action = self.pause(f'短链展开未完成：{e}。请在手机确认已进入正确商品，再点继续。', ('continue', 'skip'))
                if action == 'skip':
                    self.item_update(item, 'skipped', '短链展开失败，已跳过')
                    return
        item['expected_sku'] = sku_from_url(item.get('resolved_url', item['url']))
        time.sleep(1.5)
        page = self.screen()
        if page is None:
            self.item_update(item, "skipped", "已跳过")
            return
        for _ in range(3):
            if page.exact(ADD | CLAIM) or page.contains(COUPON_OK + COUPON_BAD):
                break
            time.sleep(1)
            page = self.screen()
            if page is None:
                self.item_update(item, "skipped", "已跳过")
                return
        kind = item["kind"]
        if kind == "auto":
            if page.exact(ADD):
                kind = "product"
            elif page.exact(CLAIM) and page.contains(("优惠券", "领券", "优惠")):
                kind = "coupon"
            else:
                action = self.pause("短链落地页类型不明确，请查看手机，选择按商品或按优惠券处理。", (("coupon", "skip") if os.environ.get("JD_COUPON_ONLY") == "1" else ("product", "coupon", "skip")))
                if action == "skip":
                    self.item_update(item, "skipped", "无法确定链接类型，已跳过")
                    return
                kind = action
                page = self.screen()
                if page is None:
                    self.item_update(item, "skipped", "已跳过")
                    return
        if os.environ.get("JD_COUPON_ONLY") == "1" and kind != "coupon":
            self.item_update(item, "skipped", "仅领券脚本跳过商品链接")
            return
        item["resolved_kind"] = kind
        if kind == "coupon":
            self.process_coupon(item, page)
        else:
            self.process_product(item, page)

    def process_coupon(self, item, page):
        # A coupon already used/claimed should never trigger a different button.
        if page.contains(COUPON_BAD):
            self.record_evidence(item, page)
            self.item_update(item, "unavailable", "优惠券已失效、领完或当前账号不符合条件")
            return
        if page.contains(COUPON_OK) and not page.exact(CLAIM):
            self.record_evidence(item, page)
            self.item_update(item, "already_claimed", "页面显示优惠券已领取")
            return
        buttons = page.exact(CLAIM)
        while len(buttons) != 1:
            action = self.pause("未找到唯一的免费领券按钮。请在手机上领取，完成后点“已处理”；也可继续检查或跳过。", ("confirmed", "continue", "skip"))
            if action == "confirmed":
                self.item_update(item, "manual_confirmed", "用户确认已处理优惠券")
                return
            if action == "skip":
                self.item_update(item, "skipped", "优惠券已跳过")
                return
            page = self.screen()
            if page is None:
                self.item_update(item, "skipped", "已跳过")
                return
            buttons = page.exact(CLAIM)
        self.checkpoint()
        item["claim_tapped"] = True
        self.save()
        self.adb.tap(buttons[0])
        if self.adb.quick_result(COUPON_OK):
            self.item_update(item, "claimed", "识别到领取成功提示")
            return
        self.verify_after_tap(item, COUPON_OK, "claimed", "领券", COUPON_BAD)

    def process_product(self, item, page):
        buttons = page.exact(ADD)
        while len(buttons) != 1:
            action = self.pause("当前页面没有唯一的“加入购物车”按钮。请在手机上进入商品详情，或手动加购后点“已处理”。", ("continue", "confirmed", "skip"))
            if action == "confirmed":
                self.item_update(item, "manual_confirmed", "用户确认已加购物车")
                return
            if action == "skip":
                self.item_update(item, "skipped", "商品已跳过")
                return
            page = self.screen()
            if page is None:
                self.item_update(item, "skipped", "已跳过")
                return
            buttons = page.exact(ADD)
        self.checkpoint()
        item["add_tapped"] = True
        self.save()
        item['cart_count_before'] = page.cart_count()
        self.adb.tap(buttons[0])
        if self.adb.quick_result(ADD_OK):
            self.item_update(item, "added", "识别到加入购物车成功提示")
            return
        page = self.screen()
        if page is None:
            self.item_update(item, "uncertain", "已点击加购，未确认结果；请核对购物车")
            return
        if page.contains(ADD_OK):
            self.record_evidence(item, page)
            self.item_update(item, "added", "识别到加入购物车成功提示")
            return
        if self.cart_increased(item, page):
            self.record_evidence(item, page)
            self.item_update(item, 'added', '加购后购物车件数增加，已记录前后数量')
            return
        # JD often opens an SKU sheet. Do not guess a size, color or paid bundle.
        if self.is_spec_sheet(page):
            automatic = self.spec_matches(item, page)
            if automatic:
                self.log('规格页编号与链接 SKU 一致，数量为 1，确认加购')
                action = 'submit_spec'
            else:
                action = self.pause("请在手机确认颜色、尺码和数量为 1。选好后点“继续提交加购”；若已手动加购，点“已处理”。", ("submit_spec", "confirmed", "skip"))
            if action == "confirmed":
                self.item_update(item, "manual_confirmed", "用户确认已加购物车")
                return
            if action == "skip":
                self.item_update(item, "uncertain", "已打开规格页，未确认加购；请核对购物车")
                return
            page = self.screen()
            if page is None:
                self.item_update(item, "uncertain", "规格确认中断，请核对购物车")
                return
            buttons = page.exact(ADD)
            if not buttons:
                buttons = page.exact({"确定"})
            if len(buttons) == 1 and self.is_spec_sheet(page) and (not automatic or self.spec_matches(item, page)):
                self.checkpoint()
                item["spec_submit_tapped"] = True
                self.save()
                self.adb.tap(buttons[0])
                if self.adb.quick_result(ADD_OK):
                    self.item_update(item, "added", "规格确认后识别到加购成功提示")
                    return
        self.verify_after_tap(item, ADD_OK, "added", "加购")

    @staticmethod
    def is_spec_sheet(page):
        has_quantity = any(normalize(n.text) in {"数量", "购买数量"} for n in page.nodes)
        has_spec = page.contains(("尺码", "颜色", "规格", "版本", "已选"))
        close = page.exact({"关闭", "关闭弹窗", "关闭弹层"})
        bottom = [n for n in page.exact(ADD | {"确定"}) if n.center[1] > page.height * 0.72]
        # A normal product page can also contain quantities and an Add button.
        # Demand a close control + a bottom confirmation before offering a second tap.
        numbered_sheet = any(re.fullmatch(r'\d{8,20}', normalize(n.text)) for n in page.nodes) and page.contains(('颜色', '版本', '尺码', '规格'))
        return bool(bottom and ((has_quantity and has_spec and close) or numbered_sheet))

    @staticmethod
    def spec_matches(item, page):
        sku = item.get('expected_sku')
        if not sku or not any(normalize(n.text) == sku for n in page.nodes):
            return False
        # This is the actual native quantity editor, not an OCR guess or a plus button.
        quantity = [n for n in page.nodes if n.source == 'xml' and normalize(n.text) == '1' and n.enabled]
        return len(quantity) == 1 and not page.contains(('请选择', '请先选择'))

    @staticmethod
    def cart_increased(item, page):
        before = item.get('cart_count_before')
        after = page.cart_count()
        if before is not None and after is not None and after == before + 1:
            item['cart_count_after'] = after
            return True
        return False

    def verify_after_tap(self, item, ok_words, status, label, bad_words=()):
        while True:
            page = self.screen()
            if page is None:
                self.item_update(item, "uncertain", f"已点击{label}，结果未确认，请人工核对")
                return
            if page.contains(ok_words):
                self.record_evidence(item, page)
                self.item_update(item, status, f"识别到{label}成功提示")
                return
            if status == 'added' and self.cart_increased(item, page):
                self.record_evidence(item, page)
                self.item_update(item, 'added', '加购后购物车件数增加，已记录前后数量')
                return
            if bad_words and page.contains(bad_words):
                self.record_evidence(item, page)
                self.item_update(item, "unavailable", "领取失败：已失效、领完或不满足条件")
                return
            self.record_evidence(item, page)
            action = self.pause(f"已点击{label}，但未读到明确结果。请核对手机；脚本不会自动重复点击。", ("confirmed", "continue", "skip"))
            if action == "confirmed":
                self.item_update(item, "manual_confirmed", f"用户确认已完成{label}")
                return
            if action == "skip":
                self.item_update(item, "uncertain", f"{label}结果未确认，请人工核对")
                return

    def run(self):
        self.state["outcome"] = "failed"
        try:
            self.adb.prepare()
            for item in self.state["items"]:
                self.checkpoint()
                try:
                    self.process(item)
                except Stopped:
                    item.update(status="uncertain" if item.get("add_tapped") or item.get("claim_tapped") else "stopped", message="任务已停止，请核对当前手机页面")
                    raise
                except Exception as e:
                    self.item_update(item, "uncertain" if item.get("add_tapped") or item.get("claim_tapped") else "error", str(e))
                    # Connection failures should not become a cascade of false attempts.
                    if self.pause("当前链接处理失败。请检查手机连接，点继续处理下一条，或停止。", ("continue", "skip")) == "skip":
                        continue
                time.sleep(0.7)
            self.state["outcome"] = "completed"
            self.log("本批处理结束，请核对结果列表和京东购物车")
        except Stopped:
            self.state["outcome"] = "stopped"
            for pending in self.state["items"]:
                if pending["status"] == "pending":
                    pending.update(status="stopped", message="任务已停止，未执行")
            self.log("任务已停止。已点击的项目请核对购物车／优惠券。")
        except Exception as e:
            self.log(f"无法启动：{e}")
        finally:
            with self.lock:
                self.state.update(running=False, paused=False, pause_options=[])
            self.save()
            try:
                self.adb.shell("rm", "-f", self.adb.remote_xml)
            except Exception:
                pass

    def save(self):
        with self.lock:
            if not self.state.get("run_dir"):
                return
            folder = Path(self.state["run_dir"])
            data = json.loads(json.dumps(self.state, ensure_ascii=False))
            temp = folder / "report.tmp.json"
            temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            temp.replace(folder / "report.json")
            with (folder / "report.csv").open("w", encoding="utf-8-sig", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(["链接", "类型", "结果", "说明"])
                for item in data["items"]:
                    writer.writerow([item["url"], item.get("resolved_kind", item["kind"]), item["status"], item["message"]])
