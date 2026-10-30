import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2] / 'desktop/electron/resources/extra/common/automation/jd-cart'
for name, filename in [('jd_engine', 'jd-engine.py'), ('vip_engine', 'vip-engine.py')]:
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, ROOT / filename)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
engine, vip = sys.modules['jd_engine'], sys.modules['vip_engine']


def page(*labels):
    return engine.Screen([engine.Node(text, (100, 1300 + index * 80, 850, 1350 + index * 80), vip.VIP_PACKAGE) for index, text in enumerate(labels)], {vip.VIP_PACKAGE})


def activity():
    return page('四川消费券', '全国可领可用', '活动规则')


class FakeAdb:
    def __init__(self, pages):
        self.pages = iter(pages)
        self.taps = []
        self.commands = []
        self.typed = []
    def prepare(self): pass
    def snapshot(self, fast=False): return next(self.pages)
    def tap(self, node): self.taps.append(node.text)
    def text(self, text): self.typed.append(text)
    def shell(self, *args): self.commands.append(args)


class Harness(vip.VipController):
    def __init__(self, pages, actions=()):
        super().__init__()
        self.adb = FakeAdb(pages)
        self.actions = iter(actions)
        self.prompts = []
        self.options = {'keyword': '四川消费券', 'activityText': '消费券', 'claimAt': 0, 'prepareOnly': False, 'refresh': False}
        self.state['items'] = [{'id': 'fixture', 'url': '', 'kind': 'vip-activity', 'status': 'pending'}]
    def pause(self, message, options=('continue', 'skip')):
        self.prompts.append(message)
        action = next(self.actions)
        assert action in options
        return action
    def save(self): pass


class VipTest(unittest.TestCase):
    def test_campaign_requires_identifying_text_and_multiple_activity_markers(self):
        self.assertTrue(vip.is_activity(activity(), '四川消费券', '消费券'))
        self.assertTrue(vip.is_activity(page('成都消费券', '全国可领可用', '活动日历'), '四川消费券', '消费券'))
        self.assertFalse(vip.is_activity(page('四川消费券', '立即购买'), '四川消费券', '消费券'))

    def test_already_registered_and_use_button_are_not_a_registration_request(self):
        p = page('您已完成实名登记', '去使用')
        self.assertFalse(vip.needs_account(p))
        self.assertEqual(vip.classify(p), 'already_claimed')
        h = Harness([activity(), p])
        h.run()
        self.assertEqual(h.state['items'][0]['status'], 'already_claimed')
        self.assertEqual(h.adb.taps, [])

    def test_captcha_has_priority_over_underlying_claim_or_success_text(self):
        self.assertEqual(vip.classify(page('领取成功', '安全验证', '立即领取')), 'captcha')
        h = Harness([page('四川消费券', '全国可领可用', '活动规则', '请依次点击', '领取')], ['skip'])
        h.run()
        self.assertEqual(h.adb.taps, [])
        self.assertEqual(h.state['items'][0]['status'], 'skipped')

    def test_after_claim_manual_verification_resumes_by_checking_result_only(self):
        h = Harness([activity(), page('立即领取'), page('安全验证', '请依次点击', '领取'), page('领取成功')], ['continue'])
        with patch('vip_engine.time.sleep'):
            h.run()
        self.assertEqual(h.adb.taps, ['立即领取'])
        self.assertEqual(h.state['items'][0]['status'], 'claimed')
        self.assertIn('依次点选', h.prompts[0])

    def test_uncertain_claim_is_never_clicked_twice(self):
        h = Harness([activity(), page('领取'), page('等待结果'), page('等待结果')], ['continue', 'skip'])
        with patch('vip_engine.time.sleep'):
            h.run()
        self.assertEqual(h.adb.taps, ['领取'])
        self.assertEqual(h.state['items'][0]['status'], 'uncertain')

    def test_prepare_only_does_not_wait_or_claim(self):
        h = Harness([activity()])
        h.options['prepareOnly'] = True
        h.run()
        self.assertEqual(h.adb.taps, [])
        self.assertEqual(h.state['items'][0]['status'], 'ready')

    def test_waiting_does_not_tap_before_release_and_can_be_stopped(self):
        h = Harness([])
        h.options['claimAt'] = 100
        h.stop_event.wait = Mock(return_value=False)
        with patch('vip_engine.time.time', side_effect=[90, 90, 95, 100]):
            h.wait_time()
        h.stop_event.wait.assert_called_once_with(1)
        self.assertEqual(h.adb.taps, [])
        self.assertFalse(h.state['waiting'])
        h.stop_event.set()
        with patch('vip_engine.time.time', return_value=90):
            with self.assertRaises(engine.Stopped): h.wait_time()

    def test_native_search_field_accepts_chinese_keyword_and_enters_activity(self):
        p = engine.Screen([engine.Node('', (100, 100, 900, 200), vip.VIP_PACKAGE, resource_id='search_input', class_name='android.widget.EditText')], {vip.VIP_PACKAGE})
        submit = engine.Screen([engine.Node('搜索', (900, 100, 1050, 180), vip.VIP_PACKAGE)], {vip.VIP_PACKAGE})
        h = Harness([p, submit, activity()])
        with patch('vip_engine.time.sleep'):
            self.assertTrue(vip.is_activity(h.navigate(), '四川消费券', '消费券'))
        self.assertEqual(h.adb.typed, ['四川消费券'])
        self.assertIn('搜索', h.adb.taps)

    def test_paid_buttons_are_not_coupon_claims(self):
        self.assertEqual(page('立即购买', '开通会员', '立即支付').exact(vip.CLAIM), [])

    def test_transient_activity_transition_is_retried_before_asking_for_manual_help(self):
        h = Harness([engine.Screen(), activity()])
        h.stop_event.wait = Mock(return_value=False)
        self.assertTrue(vip.is_activity(h.read(), '四川消费券', '消费券'))
        self.assertEqual(h.prompts, [])
