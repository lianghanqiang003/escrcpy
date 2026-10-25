#!/usr/bin/env python3
"""Deterministic local ADB fixture. Never connects to a device."""
import json
import os
import shlex
import sys
from pathlib import Path

state_file = Path(os.environ["FAKE_ADB_STATE"])
state = json.loads(state_file.read_text()) if state_file.exists() else {"page": "unknown", "taps": 0}
args = sys.argv[1:]
if args[:1] == ["-s"]:
    args = args[2:]
if args[0] == "devices":
    print("List of devices attached\nfixture-phone\tdevice")
elif args[0] == "shell":
    command = shlex.split(args[1])
    if command[:2] == ["pm", "path"]:
        print("package:/data/app/jd/base.apk")
    elif command[:2] == ["getprop", "ro.serialno"]:
        print("fixture-phone")
    elif command[:2] == ["am", "start"]:
        url = command[command.index("-d") + 1]
        state["page"] = "verification" if "/verify" in url else "coupon" if "coupon" in url else "product" if "item.jd.com" in url else "verification"
    elif command[:2] == ["input", "tap"]:
        state["taps"] += 1
        state["page"] += "-done"
elif args[:2] == ["exec-out", "cat"]:
    labels = {"coupon": "立即领取", "coupon-done": "领取成功", "product": "加入购物车", "product-done": "已加入购物车", "verification": "安全验证"}
    label = labels.get(state["page"], "安全验证")
    print(f'<hierarchy><node package="com.jingdong.app.mall" bounds="[0,0][1080,2400]" clickable="false"><node text="{label}" bounds="[200,1800][900,1920]" clickable="true"/></node></hierarchy>')
elif args[:2] == ["exec-out", "screencap"]:
    sys.stdout.buffer.write(b"fixture screenshot")
state_file.write_text(json.dumps(state))
