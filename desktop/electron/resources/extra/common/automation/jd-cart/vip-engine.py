"""VIP activity coupons: visible UI navigation, timed claim, human verification."""
import hashlib
import os
import re
import secrets
import struct
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from pathlib import Path

from jd_engine import Adb, Controller, Node, Screen, Stopped, RUNS_DIR, parse_xml, normalize

VIP_PACKAGE = "com.achievo.vipshop"
CLAIM = {"领取优惠券", "领取消费券", "立即领取", "立即领券", "免费领取", "领取", "立即抢券", "立即抢", "马上领取"}
CAPTCHA = ("安全验证", "验证码", "请依次点击", "依次点击", "按顺序点击", "请完成验证", "拖动滑块", "点击图中", "点选验证")
SUCCESS = ("领取成功", "领券成功", "已成功领取", "您已领取", "已领取")
UNAVAILABLE = ("今日已领完", "已抢光", "已领完", "本场已结束", "券已抢完", "明日再来", "今日已抢完")
MANUAL_BUTTONS = {"实名登记", "去实名", "立即实名", "立即登录", "登录注册"}


def needs_account(page):
    return bool(page.exact(MANUAL_BUTTONS)) or page.contains(("请先登录", "请登录"))


def is_activity(page, keyword, title):
    text = normalize(page.text)
    title_match = normalize(title) in text or normalize(keyword) in text
    if keyword == "四川消费券" and ("成都消费券" in text or "云购蓉城" in text):
        title_match = True
    if title_match and "消费券" in text and "进入活" in text:
        return True
    markers = ("活动规则", "开抢", "活动日历", "全国可领可用", "实名登记", "消费券每日")
    return title_match and sum(normalize(word) in text for word in markers) >= 2


def classify(page):
    if page.contains(CAPTCHA):
        return "captcha"
    if page.contains(SUCCESS):
        return "claimed"
    if page.exact({"去使用", "立即使用"}):
        return "already_claimed"
    if page.exact(CLAIM):
        return "claim"
    if page.contains(UNAVAILABLE):
        return "unavailable"
    if needs_account(page):
        return "manual"
    return "waiting"


class VipAdb(Adb):
    def foreground(self):
        result = self.shell("dumpsys", "activity", "activities", timeout=10)
        return next((line for line in result.splitlines() if "topResumedActivity=" in line), "")

    def prepare(self):
        if not self.shell("pm", "path", VIP_PACKAGE).strip():
            raise RuntimeError("手机未安装唯品会 App")
        self.shell("input", "keyevent", "KEYCODE_WAKEUP")
        self.shell("wm", "dismiss-keyguard")
        self.shell("am", "start", "-W", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-f", "0x10200000", "-p", VIP_PACKAGE, timeout=25)
        time.sleep(1)
        # Some warm launches leave this app's loading activity above its existing page.
        if "/.activity.LodingActivity" in self.foreground():
            time.sleep(1)
            if "/.activity.LodingActivity" in self.foreground():
                self.shell("input", "keyevent", "KEYCODE_BACK")

    def snapshot(self, fast=False):
        foreground = self.foreground()
        if VIP_PACKAGE not in foreground:
            return Screen(packages=set())
        page = Screen(packages={VIP_PACKAGE})
        if not fast:
            try:
                self.shell("rm", "-f", self.remote_xml)
                self.shell("uiautomator", "dump", "--compressed", self.remote_xml, timeout=10)
                page = parse_xml(self.run("exec-out", "cat", self.remote_xml, timeout=8))
                page.packages.add(VIP_PACKAGE)
            except (RuntimeError, ValueError, ET.ParseError):
                pass
        png = self.run_dir / "current.png"
        png.write_bytes(self.run("exec-out", "screencap", "-p", binary=True))
        page.screenshot = png
        header = png.read_bytes()[:24]
        if header.startswith(b"\x89PNG") and len(header) == 24:
            page.width, page.height = struct.unpack(">II", header[16:24])
        for node in self.ocr(png):
            node.package = VIP_PACKAGE
            page.nodes.append(node)
        return page

    def text(self, value):
        yadb = os.environ.get("WORKBENCH_YADB", "")
        if not yadb or not Path(yadb).is_file():
            raise RuntimeError("中文输入组件未就绪，请在手机输入搜索词")
        remote = "/data/local/tmp/escrcpy-vip-yadb"
        self.run("push", yadb, remote)
        self.shell("input", "keycombination", "113", "29")
        self.shell("input", "keyevent", "KEYCODE_DEL")
        self.shell("app_process", f"-Djava.class.path={remote}", "/data/local/tmp", "com.ysbing.yadb.Main", "-keyboard", value)


class VipController(Controller):
    def start(self, serial, options):
        keyword = str(options.get("keyword", "")).strip()
        title = str(options.get("activityText", "")).strip()
        claim_at = float(options.get("claimAt", 0)) / 1000
        if not keyword or not title or len(keyword) > 80 or len(title) > 100 or not claim_at:
            raise ValueError("请填写搜索词、活动识别文字和放券时间")
        self.options = {**options, "keyword": keyword, "activityText": title, "claimAt": claim_at}
        folder = RUNS_DIR / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3))
        folder.mkdir(parents=True, mode=0o700)
        item = {"id": hashlib.sha256((keyword + title).encode()).hexdigest()[:16], "url": "", "title": keyword + " · " + title, "kind": "vip-activity", "status": "pending", "message": "等待定位活动"}
        self.state = {"running": True, "paused": False, "waiting": False, "pause_options": [], "message": "打开唯品会", "items": [item], "logs": [], "serial": serial, "run_dir": str(folder), "outcome": "failed"}
        self.stop_event.clear()
        self.adb = VipAdb(serial, folder)
        self.adb.stop_event = self.stop_event
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def read(self, fast=False):
        self.checkpoint()
        page = self.adb.snapshot(fast=fast)
        for _ in range(4):
            if VIP_PACKAGE in page.packages:
                break
            self.stop_event.wait(.5)
            self.checkpoint()
            page = self.adb.snapshot(fast=fast)
        while VIP_PACKAGE not in page.packages:
            if self.pause("请解锁手机并打开唯品会，再点继续检查。") == "skip":
                return None
            page = self.adb.snapshot(fast=fast)
        return page

    def human_gate(self, page):
        while page and (page.contains(CAPTCHA) or (needs_account(page) and not page.exact(CLAIM))):
            if not page.contains(CAPTCHA) and page.contains(SUCCESS):
                return page
            self.state["pause_reason"] = "captcha" if page.contains(CAPTCHA) else "account"
            message = "出现图片／安全验证码。请在手机画面按提示依次点选文字并完成验证，然后点继续检查。" if self.state["pause_reason"] == "captcha" else "请在手机完成登录或实名登记，再点继续检查。"
            if self.pause(message) == "skip":
                return None
            self.state["pause_reason"] = ""
            page = self.read(fast=True)
        return page

    def navigate(self):
        keyword, title = self.options["keyword"], self.options["activityText"]
        page = self.read()
        if page is None or is_activity(page, keyword, title):
            return page
        page = self.human_gate(page)
        if page is None:
            return None
        # Prefer the native search field; OCR is used only for an exact search label.
        inputs = [node for node in page.nodes if node.class_name.endswith("EditText")]
        if not inputs:
            candidates = [node for node in page.nodes if node.actionable and node.enabled and node.center[1] < page.height * .28 and ("search" in node.resource_id.lower() or normalize(node.text).startswith(("搜索", "搜“", '搜"')))]
            candidates = self.unique(candidates)
            if len(candidates) == 1:
                self.adb.tap(candidates[0])
                page = self.read()
                if page is None:
                    return None
                inputs = self.unique([node for node in page.nodes if node.class_name.endswith("EditText")])
        if len(inputs) == 1:
            self.log("搜索：" + keyword)
            self.adb.tap(inputs[0])
            try:
                self.adb.text(keyword)
                submit_page = self.read()
                if submit_page is None:
                    return None
                search = [node for node in submit_page.exact({"搜索"}) if node.center[1] < submit_page.height * .28]
                if len(search) == 1:
                    self.adb.tap(search[0])
                else:
                    self.adb.shell("input", "keyevent", "KEYCODE_ENTER")
                time.sleep(1)
                page = self.read()
            except RuntimeError as error:
                self.log(str(error))
        for _ in range(3):
            if page is None or is_activity(page, keyword, title):
                return page
            page = self.human_gate(page)
            if page is None:
                return None
            entries = [node for node in page.exact({normalize(title), normalize(keyword)}) if not node.class_name.endswith("EditText") and node.center[1] > page.height * .15]
            if len(entries) == 1:
                self.adb.tap(entries[0])
                time.sleep(1)
                page = self.read()
            else:
                break
        while page and not is_activity(page, keyword, title):
            if self.pause(f"请在唯品会搜索“{keyword}”，进入包含“{title}”的消费券活动页，再点继续检查。") == "skip":
                return None
            page = self.read()
        return page

    @staticmethod
    def unique(nodes):
        result = []
        for node in nodes:
            if not any(abs(node.center[0] - old.center[0]) < 70 and abs(node.center[1] - old.center[1]) < 50 for old in result):
                result.append(node)
        return result

    def wait_time(self):
        target = self.options["claimAt"]
        if time.time() >= target:
            return
        self.state.update(waiting=True, wait_until=target * 1000)
        display = datetime.fromtimestamp(target, timezone(timedelta(hours=8))).strftime("%m-%d %H:%M:%S")
        self.log("活动页已就绪，等待北京时间 " + display)
        self.save()
        while time.time() < target:
            self.checkpoint()
            self.stop_event.wait(min(1, target - time.time()))
        self.state.update(waiting=False)
        self.log("已到放券时间，检查领券按钮")

    def claim(self, item):
        deadline = time.monotonic() + 120
        refreshes = getattr(self, "initial_refreshes", 0)
        next_refresh = time.monotonic() + 5
        while time.monotonic() < deadline:
            page = self.human_gate(self.read(fast=True))
            if page is None:
                self.item_update(item, "uncertain" if item.get("claim_tapped") else "skipped", "已跳过，请核对当前手机")
                return
            result = classify(page)
            if result in {"claimed", "already_claimed", "unavailable"}:
                self.record_evidence(item, page)
                self.item_update(item, result, "页面显示已领取／领取成功" if result != "unavailable" else "页面显示本场已领完或活动结束")
                return
            if item.get("claim_tapped"):
                self.record_evidence(item, page)
                action = self.pause("已点击领券，尚未读到明确成功结果。请核对手机，脚本不会重复点击。", ("continue", "confirmed", "skip"))
                if action != "continue":
                    self.item_update(item, "manual_confirmed" if action == "confirmed" else "uncertain", "用户确认已处理" if action == "confirmed" else "领券结果待核对")
                    return
                continue
            buttons = page.exact(CLAIM)
            if len(buttons) == 1:
                self.checkpoint()
                item["claim_tapped"] = True
                self.item_update(item, "opening", "点击唯一的免费领券按钮")
                self.adb.tap(buttons[0])
                time.sleep(.5)
                continue
            if len(buttons) > 1:
                if self.pause("活动里有多个领券按钮，请在手机选择目标优惠券并领取，然后点继续检查。") == "skip":
                    self.item_update(item, "skipped", "未确定目标优惠券，已跳过")
                    return
                continue
            if self.options.get("refresh", True) and refreshes < 3 and time.monotonic() >= next_refresh:
                # Refresh this visible activity only. Never refresh a verification page.
                self.adb.shell("input", "swipe", str(page.width // 2), str(int(page.height * .23)), str(page.width // 2), str(int(page.height * .58)), "500")
                refreshes += 1
                next_refresh = time.monotonic() + 10
                self.log(f"等待按钮展示，已下拉刷新 {refreshes}/3 次")
            self.stop_event.wait(1.5)
        self.item_update(item, "uncertain" if item.get("claim_tapped") else "unavailable", "检查超时，请核对放券时间、活动页面和领券结果")

    def run(self):
        item = self.state["items"][0]
        try:
            self.adb.prepare()
            self.item_update(item, "opening", "定位唯品会消费券活动")
            page = self.navigate()
            if page is None:
                self.item_update(item, "skipped", "活动定位已跳过")
            elif self.options.get("prepareOnly"):
                self.record_evidence(item, page)
                self.item_update(item, "ready", "活动页已定位；仅检查模式，不执行领券" + ("。当前有安全验证提示" if page.contains(CAPTCHA) else ""))
            elif self.human_gate(page) is None:
                self.item_update(item, "skipped", "验证或账号处理已跳过")
            else:
                waited = time.time() < self.options["claimAt"]
                self.wait_time()
                if waited and self.options.get("refresh", True):
                    current = self.human_gate(self.read(fast=True))
                    if current is None:
                        self.item_update(item, "skipped", "放券时间到达后，活动检查已跳过")
                        self.state["outcome"] = "completed"
                        return
                    if is_activity(current, self.options["keyword"], self.options["activityText"]):
                        self.adb.shell("input", "swipe", str(current.width // 2), str(int(current.height * .23)), str(current.width // 2), str(int(current.height * .58)), "500")
                        self.initial_refreshes = 1
                        self.log("已到放券时间，下拉刷新活动，更新当场资格与按钮")
                self.claim(item)
            self.state["outcome"] = "completed"
        except Stopped:
            self.state["outcome"] = "stopped"
            self.item_update(item, "uncertain" if item.get("claim_tapped") else "stopped", "任务已停止，已发出的操作请核对手机")
        except Exception as error:
            self.item_update(item, "uncertain" if item.get("claim_tapped") else "error", str(error))
        finally:
            self.state.update(running=False, paused=False, waiting=False, pause_options=[])
            self.save()
