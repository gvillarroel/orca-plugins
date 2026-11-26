"""Offline UI regression test. Requires Python Playwright and a Chromium browser.

Run with python tests/panel_browser.py. Set PLAYWRIGHT_CHANNEL=chrome to use installed Chrome.
"""

import os
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


PANEL = Path(__file__).resolve().parents[1] / "plugins" / "pi-durable" / "panel.html"


class PanelTest(unittest.TestCase):
    def setUp(self):
        playwright = sync_playwright().start()
        self.addCleanup(playwright.stop)
        browser = playwright.chromium.launch(channel=os.getenv("PLAYWRIGHT_CHANNEL"))
        self.addCleanup(browser.close)
        context = browser.new_context(offline=True)
        self.page = context.new_page()
        self.el = self.page.locator
        self.online = True
        self.lose_ack = False
        self.calls = []
        self.storage = {}
        self.profiles = {
            "legacy": dict(id="legacy", name="Anterior", managed=True, model="legacy/model",
                           instructions="Instrucciones originales"),
            "external:s/a": dict(id="external:s/a", name="Externo", managed=False, online=False),
        }
        self.page.expose_function("request", self.request)
        self.page.expose_function("storeKeys", lambda: list(self.storage))
        self.page.expose_function("storeGet", lambda key: self.storage.get(key))
        self.page.expose_function("storeSet", lambda key, value: self.storage.update({key: value}))
        self.page.expose_function("storeDelete", lambda key: self.storage.pop(key, None))

    def open_panel(self):
        self.page.goto("about:blank")
        self.page.evaluate("""window.orca = {
          plugin: { request: window.request },
          storage: { keys: storeKeys, get: storeGet, set: storeSet, delete: storeDelete }
        }""")
        self.page.set_content(PANEL.read_text(encoding="utf-8"))
        expect(self.el("#count")).to_contain_text("agente")

    def request(self, method, args, _options):
        self.calls.append((method, args))
        if method == "agents.list":
            summaries = [
                {k: v for k, v in profile.items() if k != "instructions"}
                for profile in self.profiles.values() if self.online or not profile["managed"]
            ]
            if args.get("cursor") == "2":
                return {"agents": summaries[1:]}
            result = {"agents": summaries[:1], "models": ["demo"], "managedOnline": self.online}
            if len(summaries) > 1:
                result["nextCursor"] = "2"
            return result
        if method == "agents.create":
            profile = dict(id=args["id"], name=args["name"], model=args["model"],
                           instructions=args["instructions"], managed=True)
            self.profiles[profile["id"]] = profile
            if self.lose_ack:
                self.lose_ack = False
                raise RuntimeError("Confirmación interrumpida")
            return profile
        if method == "agents.profile":
            return self.profiles[args["id"]]
        if method == "chat.read":
            return {"messages": [], "busy": False}
        raise AssertionError(method)

    def test_lost_create_reply_survives_reopening_the_panel(self):
        for explicit_id in ["", "elegido"]:
            with self.subTest(explicit_id=explicit_id):
                self.open_panel()
                self.el("#new").click()
                self.el("#agent-name").fill("Revisor")
                self.el("#agent-id").fill(explicit_id)
                self.assertEqual(self.el("#agent-model option").all_text_contents(), ["demo"])
                self.lose_ack = True
                self.el("#save").click()
                expect(self.el("#profile-error")).to_contain_text("Confirmación interrumpida")
                self.open_panel()
                self.el("#new").click()
                expect(self.el("#agent-name")).to_have_value("Revisor")
                self.el("#save").click()
                expect(self.el("#chat-title")).to_have_text("Revisor")
                attempts = [args for method, args in self.calls if method == "agents.create"]
                self.assertEqual(attempts[-1], attempts[-2])
                self.assertTrue(attempts[-1]["requestId"])
                self.assertTrue(attempts[-1]["id"])
                if explicit_id:
                    self.assertEqual(attempts[-1]["id"], explicit_id)
                self.assertFalse(self.storage)

    def test_changed_intent_gets_a_new_request(self):
        self.open_panel()
        self.el("#new").click()
        self.el("#agent-name").fill("Primero")
        self.lose_ack = True
        self.el("#save").click()
        expect(self.el("#pending-create")).to_be_visible()
        self.el("#agent-name").fill("Segundo")
        self.el("#save").click()
        expect(self.el("#chat-title")).to_have_text("Segundo")
        first, second = [args for method, args in self.calls if method == "agents.create"]
        self.assertNotEqual(first["id"], second["id"])
        self.assertNotEqual(first["requestId"], second["requestId"])
        self.assertFalse(self.storage)

    def test_pagination_old_profiles_and_offline_service(self):
        self.open_panel()
        expect(self.el("#agents button")).to_have_count(2)
        self.el("#agents button").filter(has_text="Anterior").click()
        self.assertNotIn("agents.profile", [method for method, _ in self.calls])
        self.el("#edit").click()
        expect(self.el("#agent-instructions")).to_have_value("Instrucciones originales")
        expect(self.el("#agent-model")).to_have_value("legacy/model")
        self.online = False
        self.el("#profile-back").click()
        self.el("#chat-back").click()
        expect(self.el("#new")).to_be_disabled()
        expect(self.el("#list-warning")).to_contain_text("inicia el servicio local")
        self.el("#agents button").filter(has_text="Externo").click()
        self.el("#edit").click()
        expect(self.el("#agent-model")).to_be_disabled()
        expect(self.el("#save")).to_be_hidden()
        self.assertEqual([args for method, args in self.calls if method == "agents.profile"], [{"id": "legacy"}])


if __name__ == "__main__":
    unittest.main()
