import importlib.util
import shlex
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / 'desktop/electron/resources/extra/common/automation/jd-cart'
spec = importlib.util.spec_from_file_location('jd_engine', ROOT / 'jd-engine.py')
engine = importlib.util.module_from_spec(spec)
sys.modules['jd_engine'] = engine
spec.loader.exec_module(engine)
from jd_engine import (ADD, CLAIM, Adb, Controller, JD_PACKAGE, Node, Screen,
                      allowed_url, expand_short_link, extract_links, parse_xml)


def screen(*labels):
    return Screen([Node(t, (100, 1500 + i * 80, 500, 1560 + i * 80)) for i, t in enumerate(labels)], {JD_PACKAGE})


class FakeAdb:
    def __init__(self):
        self.taps = []
        self.run_dir = None
    def tap(self, node):
        self.taps.append(node.text)
    def quick_result(self, _):
        return False


class Harness(Controller):
    def __init__(self, pages=(), actions=()):
        super().__init__()
        self.adb = FakeAdb()
        self.pages = iter(pages)
        self.actions = iter(actions)
        self.prompts = []
    def screen(self):
        return next(self.pages)
    def pause(self, message, options=("continue", "skip")):
        self.prompts.append((message, options))
        action = next(self.actions)
        assert action in options
        return action
    def save(self):
        pass


class LinksTest(unittest.TestCase):
    def test_short_link_keeps_complete_tracked_product_url(self):
        final = 'https://item.m.jd.com/product/123456.html?uabt=abc&cu=true&utm_campaign=t_2037_'
        class Response:
            def __init__(self, url, body): self.url, self.body = url, body
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _): return self.body
        from unittest.mock import Mock
        opener = Mock()
        opener.open.side_effect = [Response('https://u.jd.com/abc', b"var hrl='https://u.jd.com/jda?e=1&p=kept';"), Response(final, b'<html></html>')]
        with patch('jd_engine.urllib.request.build_opener', return_value=opener):
            self.assertEqual(expand_short_link('https://u.jd.com/abc'), final)
        self.assertEqual(opener.open.call_args_list[1].args[0].full_url, 'https://u.jd.com/jda?e=1&p=kept')

    def test_markdown_duplicates_and_exact_attribution(self):
        url = 'https://u.jd.com/5rpP6E2?a=1&b=2%2F3'
        rows, rejected = extract_links(f'商品 [{url}]({url})\n{url}\n')
        self.assertEqual([r['url'] for r in rows], [url])
        self.assertEqual(rows[0]['kind'], 'auto')
        self.assertEqual(rejected, [])

    def test_coupon_and_product_mixed(self):
        coupon = 'https://coupon.m.jd.com/coupons/show.action?linkKey=Ab_-1&foo=2'
        rows, _ = extract_links(f'领券：{coupon}。\nhttps://item.jd.com/123.html\nhttps://u.jd.com/abc')
        self.assertEqual([r['kind'] for r in rows], ['coupon', 'product', 'auto'])
        self.assertEqual(rows[0]['url'], coupon)

    def test_markdown_label_is_not_an_additional_executable_link(self):
        rows, _ = extract_links(r'[https://u.jd.com/escaped\_label](https://u.jd.com/actual_target?a=1&b=2)')
        self.assertEqual([row['url'] for row in rows], ['https://u.jd.com/actual_target?a=1&b=2'])

    def test_jd_lookalikes_and_unsafe_urls_rejected(self):
        for url in ['https://jd.com.evil.test/a', 'https://evil.test/?jd.com', 'https://u.jd.com@evil.test/a', 'https://u.jd.com:999/a', 'javascript:alert(1)', 'file:///etc/passwd', 'https://u.jd.com/ab\ncd']:
            self.assertFalse(allowed_url(url), url)
        for url in ['https://u.jd.com/abc', 'https://item.jd.com/123.html', 'https://3.cn/abc']:
            self.assertTrue(allowed_url(url), url)

    def test_remote_shell_preserves_url_as_one_argument(self):
        url = 'https://u.jd.com/abc?a=1&b=$(touch /tmp/nope)`whoami`'
        adb = Adb('test', binary='/fake/adb')
        with patch.object(adb, 'run', return_value='ok') as run:
            adb.shell('am', 'start', '-d', url)
            shell_command = run.call_args.args[1]
            self.assertEqual(shlex.split(shell_command), ['am', 'start', '-d', url])


class UiTest(unittest.TestCase):
    def test_cart_quantity_delta_is_recorded_and_must_be_exactly_one(self):
        item = {'cart_count_before': 13}
        self.assertTrue(Controller.cart_increased(item, screen('购物车14件')))
        self.assertEqual(item['cart_count_after'], 14)
        self.assertFalse(Controller.cart_increased({'cart_count_before': 13}, screen('购物车15件')))
        self.assertFalse(Controller.cart_increased({}, screen('购物车14件')))

    def test_normal_page_is_not_a_spec_confirmation_sheet(self):
        self.assertFalse(Controller.is_spec_sheet(screen('加入购物车', '数量', '已选', '颜色')))

    def test_spec_confirmation_requires_close_and_bottom_button(self):
        page = Screen([
            Node('数量', (10, 1700, 120, 1800)),
            Node('颜色', (10, 1600, 120, 1700)),
            Node('关闭', (980, 900, 1050, 980)),
            Node('确定', (100, 2200, 980, 2330))], {JD_PACKAGE})
        self.assertTrue(Controller.is_spec_sheet(page))

    def test_auto_spec_confirmation_requires_exact_sku_and_native_quantity_one(self):
        p = Screen([Node('100366163164', (400, 550, 850, 610), source='ocr'),
                    Node('1', (488, 636, 557, 716)),
                    Node('颜色', (40, 1200, 200, 1250), source='ocr'),
                    Node('确定', (480, 2140, 590, 2200), source='ocr')], {JD_PACKAGE})
        self.assertTrue(Controller.is_spec_sheet(p))
        self.assertTrue(Controller.spec_matches({'expected_sku': '100366163164'}, p))
        self.assertFalse(Controller.spec_matches({'expected_sku': '100366163165'}, p))
        p.nodes[1].text = '2'
        self.assertFalse(Controller.spec_matches({'expected_sku': '100366163164'}, p))

    def test_wireless_reconnect_never_replays_a_tap(self):
        adb = Adb('192.168.1.2:1234', binary='/fake/adb')
        import subprocess
        failed = subprocess.CompletedProcess([], 1, b'', b'error: closed')
        with patch('jd_engine.subprocess.run', return_value=failed) as run:
            with self.assertRaises(RuntimeError):
                adb.shell('input', 'tap', '10', '20')
            self.assertEqual(run.call_count, 1)

    def test_heading_is_not_a_claim_button(self):
        xml = '''<hierarchy><node package="com.jingdong.app.mall" bounds="[0,0][1080,2400]" text="领取优惠券" clickable="false"><node text="领取优惠券" bounds="[300,80][700,200]" clickable="false"/><node text="您关注的活动已结束" bounds="[100,1000][900,1300]" clickable="false"/></node></hierarchy>'''
        page = parse_xml(xml)
        self.assertFalse(page.exact(CLAIM))
        h = Harness()
        item = {'id': 'x'}
        h.process_coupon(item, page)
        self.assertEqual(item['status'], 'unavailable')
        self.assertEqual(h.adb.taps, [])

    def test_child_text_in_clickable_parent_is_actionable(self):
        xml = '''<hierarchy><node package="com.jingdong.app.mall" bounds="[0,0][1080,2400]" clickable="false"><node bounds="[100,1500][900,1650]" clickable="true"><node text="立即领取" bounds="[350,1520][650,1620]" clickable="false"/></node></node></hierarchy>'''
        self.assertEqual(len(parse_xml(xml).exact(CLAIM)), 1)

    def test_multiple_products_pause_without_guessing(self):
        h = Harness(actions=['skip'])
        page = screen('加入购物车', '加购物车')
        item = {'id': 'x'}
        h.process_product(item, page)
        self.assertEqual(item['status'], 'skipped')
        self.assertEqual(h.adb.taps, [])

    def test_uncertain_add_never_repeats_tap(self):
        detail = screen('加入购物车', '颜色', '数量')
        h = Harness(pages=[detail, detail, detail], actions=['continue', 'skip'])
        item = {'id': 'x'}
        h.process_product(item, detail)
        self.assertEqual(h.adb.taps, ['加入购物车'])
        self.assertEqual(item['status'], 'uncertain')
        self.assertTrue(item['add_tapped'])

    def test_clear_success(self):
        h = Harness(pages=[screen('已加入购物车')])
        item = {'id': 'x'}
        h.process_product(item, screen('加入购物车'))
        self.assertEqual(item['status'], 'added')
        self.assertEqual(h.adb.taps, ['加入购物车'])

    def test_already_claimed_never_reclaims(self):
        h = Harness()
        item = {'id': 'x'}
        h.process_coupon(item, screen('已领取'))
        self.assertEqual(item['status'], 'already_claimed')
        self.assertEqual(h.adb.taps, [])

    def test_paid_actions_not_allowed(self):
        page = screen('立即购买', '提交订单', '立即支付', '开通PLUS会员', '购买优惠券')
        self.assertFalse(page.exact(ADD | CLAIM | {'确定'}))

    def test_capture_after_click_cannot_report_success_without_evidence(self):
        h = Harness(pages=[screen('优惠券'), screen('优惠券')], actions=['confirmed'])
        item = {'id': 'x'}
        h.process_coupon(item, screen('立即领取'))
        self.assertEqual(item['status'], 'manual_confirmed')
        self.assertEqual(h.adb.taps, ['立即领取'])


if __name__ == '__main__':
    unittest.main()
