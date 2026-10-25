"""Private stdio bridge for the desktop workbench. No HTTP listener."""
import importlib.util
import json
import sys
import threading
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("jd_engine", Path(__file__).with_name("jd-engine.py"))
engine = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = engine
spec.loader.exec_module(engine)


def emit(data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def commands(controller):
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with controller.lock:
                if request.get("action") != "stop" and request.get("pauseId") != controller.state.get("pause_id"):
                    raise ValueError("暂停提示已经更新，请重新确认")
                controller.respond(request.get("action"))
        except Exception as error:
            emit({"type": "command-error", "message": str(error)})
    controller.respond("stop")


def main():
    request = json.loads(sys.stdin.readline(200_000))
    if request.get("mode") == "parse":
        items, rejected = engine.extract_links(str(request.get("text", "")))
        if len(items) > 100:
            raise ValueError("每批最多 100 条链接")
        emit({"type": "parsed", "items": items, "rejected": rejected})
        return
    if request.get("scriptId") == "jd-check":
        adb = engine.Adb(str(request["deviceId"]))
        installed = bool(adb.shell("pm", "path", engine.JD_PACKAGE).strip())
        serial = adb.shell("getprop", "ro.serialno").strip()
        emit({"type": "state", "state": {
            "running": False, "paused": False, "outcome": "completed" if installed else "failed",
            "message": "京东已安装，连接正常" if installed else "未检测到京东 App",
            "items": [{"id": "check", "kind": "check", "url": "", "status": "checked" if installed else "error",
                       "message": ("京东已安装，连接正常 · " + serial) if installed else "未检测到京东 App"}],
            "logs": [], "pause_options": [], "run_dir": ""
        }})
        return
    controller = engine.Controller()
    controller.start(str(request["deviceId"]), request["items"], str(request.get("commissionEntry", "")))
    threading.Thread(target=commands, args=(controller,), daemon=True).start()
    previous = ""
    while True:
        with controller.lock:
            state = json.dumps(controller.state, ensure_ascii=False)
            running = controller.state["running"]
        if state != previous:
            emit({"type": "state", "state": json.loads(state)})
            previous = state
        if not running:
            controller.worker.join(timeout=3)
            return
        time.sleep(0.25)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "fatal", "message": str(error)})
        sys.exit(1)
