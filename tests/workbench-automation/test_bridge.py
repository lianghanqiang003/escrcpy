import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRIDGE = HERE.parents[1] / "desktop/electron/resources/extra/common/automation/jd-cart/bridge.py"


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.fake = self.folder / "adb"
        self.fake.write_text((HERE / "fake-adb.py").read_text())
        self.fake.chmod(0o700)
        self.env = {**os.environ, "ADB": str(self.fake), "JD_RUNS_DIR": str(self.folder / "runs"), "JD_TESSDATA": str(self.folder / "no-ocr"), "FAKE_ADB_STATE": str(self.folder / "device.json"), "JD_COUPON_ONLY": "0"}
        self.process = None

    def tearDown(self):
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
                self.process.wait(timeout=5)
            for stream in [self.process.stdin, self.process.stdout, self.process.stderr]:
                stream.close()
        self.temp.cleanup()

    def launch(self, items, script="jd-cart"):
        self.process = subprocess.Popen([sys.executable, "-u", str(BRIDGE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        self.messages = queue.Queue()
        threading.Thread(target=lambda: [self.messages.put(json.loads(line)) for line in self.process.stdout], daemon=True).start()
        self.send({"mode": "run", "scriptId": script, "deviceId": "fixture-phone", "items": items})

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()

    def until(self, condition):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            value = self.messages.get(timeout=max(.1, deadline - time.monotonic()))
            if condition(value):
                return value
        self.fail("Bridge did not emit expected state")

    def test_coupons_run_before_products_and_each_tap_occurs_once(self):
        self.launch([{"url": "https://item.jd.com/123.html", "kind": "product"}, {"url": "https://coupon.m.jd.com/coupons/test", "kind": "coupon"}])
        final = self.until(lambda value: value.get("type") == "state" and not value["state"]["running"])["state"]
        self.assertEqual([item["status"] for item in final["items"]], ["claimed", "added"])
        self.assertEqual(json.loads((self.folder / "device.json").read_text())["taps"], 2)
        self.assertTrue((Path(final["run_dir"]) / "report.json").is_file())

    def test_stale_pause_response_is_rejected_and_stop_does_not_click(self):
        self.launch([{"url": "https://3.cn/fixture", "kind": "auto"}])
        paused = self.until(lambda value: value.get("type") == "state" and value["state"].get("paused"))["state"]
        self.send({"action": "continue", "pauseId": "stale"})
        self.assertEqual(self.until(lambda value: value.get("type") == "command-error")["type"], "command-error")
        self.send({"action": "stop"})
        final = self.until(lambda value: value.get("type") == "state" and not value["state"]["running"])["state"]
        self.assertEqual(final["outcome"], "stopped")
        self.assertTrue(paused["pause_id"])
        self.assertEqual(json.loads((self.folder / "device.json").read_text())["taps"], 0)

    def test_coupon_only_mode_never_adds_an_auto_classified_product(self):
        self.env["JD_COUPON_ONLY"] = "1"
        self.launch([{"url": "https://item.jd.com/123.html", "kind": "auto"}], "jd-coupon")
        final = self.until(lambda value: value.get("type") == "state" and not value["state"]["running"])["state"]
        self.assertEqual(final["items"][0]["status"], "skipped")
        self.assertEqual(json.loads((self.folder / "device.json").read_text())["taps"], 0)

    def test_valid_resume_checks_the_page_again_and_claims_once(self):
        self.launch([{"url": "https://coupon.m.jd.com/verify", "kind": "coupon"}])
        paused = self.until(lambda value: value.get("type") == "state" and value["state"].get("paused"))["state"]
        (self.folder / "device.json").write_text(json.dumps({"page": "coupon", "taps": 0}))
        self.send({"action": "continue", "pauseId": paused["pause_id"]})
        final = self.until(lambda value: value.get("type") == "state" and not value["state"]["running"])["state"]
        self.assertEqual(final["items"][0]["status"], "claimed")
        self.assertEqual(json.loads((self.folder / "device.json").read_text())["taps"], 1)
