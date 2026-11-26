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
        self.models = ["demo"]
        self.lose_ack = False
        self.native_available = False
        self.native_review = None
        self.calls = []
        self.storage = {}
        self.management_version = 1
        self.evolution = dict(revision=1, source="return original()", proposal=None, job=None,
                              model="demo", canRollback=False)
        self.evolution_reads = 0
        self.reject_build = self.lose_proposal_ack = self.lose_delete_ack = False
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
        expect(self.el("html")).to_have_attribute("lang", "en")
        expect(self.page.get_by_role("heading", name="Agents", exact=True)).to_be_visible()
        expect(self.el("#count")).to_contain_text("agent")

    def request(self, method, args, _options):
        self.calls.append((method, args))
        if method == "agents.list":
            summaries = [
                {k: v for k, v in profile.items() if k != "instructions"}
                for profile in self.profiles.values() if self.online or not profile["managed"]
            ]
            if args.get("cursor") == "2":
                return {"agents": summaries[1:]}
            result = {"agents": summaries[:1], "models": self.models, "managedOnline": self.online,
                      "managementVersion": self.management_version}
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
        if method == "agents.delete":
            self.profiles.pop(args["id"], None)
            if self.lose_delete_ack:
                self.lose_delete_ack = False
                raise RuntimeError("Connection lost")
            return {"id": args["id"], "deleted": True}
        if method == "evolution.get":
            self.evolution_reads += 1
            job = self.evolution["job"]
            if job and job["status"] == "running" and self.evolution_reads >= 2:
                if self.reject_build:
                    job.update(status="failed", error="Could not meet the requirement.")
                else:
                    self.evolution.update(job=None, proposal=dict(requestId=job["requestId"],
                        requirement=job["requirement"], baseRevision=self.evolution["revision"],
                        source="return count(words)", builder=job["builder"],
                        checks=[dict(input="/words one two", expected="2"), dict(input="Hello", expected=None)]))
            return self.evolution
        if method == "evolution.propose":
            if self.lose_proposal_ack:
                self.lose_proposal_ack = False
                raise RuntimeError("Delivery unconfirmed")
            self.evolution_reads = 0
            self.evolution["job"] = dict(requestId=args["requestId"], requirement=args["requirement"],
                                         builder=args["builderModel"], status="running")
            return self.evolution
        if method == "evolution.apply":
            self.evolution.update(revision=2, source=self.evolution["proposal"]["source"],
                                  proposal=None, job=None, canRollback=True)
            return self.evolution
        if method == "evolution.rollback":
            self.evolution.update(revision=3, source="return original()", proposal=None, job=None, canRollback=False)
            return self.evolution
        if method == "chat.openNative":
            if self.native_review and args.get("reviewId") != self.native_review:
                return {"status": "needsReview", "reviewId": self.native_review, "message": "Check your open tabs."}
            if self.native_available:
                return {"status": "opened", "message": "Opened in Orca Chat.", "sessionId": "test-session"}
            raise RuntimeError("Install the Pi Durable provider to use Orca Chat.")
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
        expect(self.el("#agents li")).to_have_count(2)
        self.page.get_by_role("button", name="Details for Anterior").click()
        self.assertNotIn("agents.profile", [method for method, _ in self.calls])
        self.el("#edit").click()
        expect(self.el("#agent-instructions")).to_have_value("Instrucciones originales")
        expect(self.el("#agent-model")).to_have_value("legacy/model")
        self.online = False
        self.el("#profile-back").click()
        self.el("#chat-back").click()
        expect(self.el("#new")).to_be_disabled()
        expect(self.el("#list-warning")).to_contain_text("start the local service")
        self.el("#agents button").filter(has_text="Externo").click()
        self.el("#edit").click()
        expect(self.el("#agent-model")).to_be_disabled()
        expect(self.el("#save")).to_be_hidden()
        self.assertEqual([args for method, args in self.calls if method == "agents.profile"], [{"id": "legacy"}])

    def test_managed_agent_selection_prefers_native_chat_and_details_reopens_durable_history(self):
        self.native_available = True
        self.open_panel()
        self.el("#agents .agent").filter(has_text="Anterior").click()
        expect(self.el("#launch-status")).to_have_text("Opened in Orca Chat.")
        expect(self.el("#conversation")).to_be_hidden()
        self.assertEqual([args for method, args in self.calls if method == "chat.openNative"], [{"id": "legacy"}])
        self.page.get_by_role("button", name="Details for Anterior").click()
        expect(self.el("#chat-title")).to_have_text("Anterior")
        expect(self.el("#launch-error")).to_be_hidden()
        self.el("#chat-back").click()
        self.native_available = False
        self.el("#agents .agent").filter(has_text="Anterior").click()
        expect(self.el("#launch-error")).to_contain_text("Install the Pi Durable provider")
        expect(self.el("#messages")).to_be_attached()

    def test_uncertain_launch_requires_an_explicit_new_tab_request(self):
        self.native_available = True
        self.native_review = "receipt-1"
        self.open_panel()
        self.el("#agents .agent").filter(has_text="Anterior").click()
        expect(self.el("#launch-status")).to_have_text("Check your open tabs.")
        expect(self.el("#new-native")).to_be_visible()
        self.el("#new-native").click()
        expect(self.el("#new-native")).to_be_hidden()
        expect(self.el("#launch-status")).to_have_text("Opened in Orca Chat.")
        self.assertEqual([args for method, args in self.calls if method == "chat.openNative"], [
            {"id": "legacy"}, {"id": "legacy", "newChat": True, "reviewId": "receipt-1"},
        ])


    def open_evolution(self):
        self.open_panel()
        self.page.get_by_role("button", name="Details for Anterior").click()
        self.el("#evolve").click()
        expect(self.el("#requirement")).to_be_visible()

    def test_review_apply_and_restore_an_evolution(self):
        self.models.append("openai/gpt-4.1-mini")
        self.open_evolution()
        expect(self.el("#evolution-target")).to_contain_text("legacy")
        expect(self.el("#builder-model")).to_have_value("demo")
        self.el("#builder-model").select_option("openai/gpt-4.1-mini")
        expect(self.el("#demo-example")).to_be_hidden()
        self.el("#requirement").fill("Add a /words command that counts words.")
        self.el("#acceptance-example summary").click()
        self.el("#example-input").fill("/words real check")
        self.el("#propose").click()
        expect(self.el("#evolution-error")).to_contain_text("Complete both fields")
        self.el("#example-reply").fill("2")
        self.el("#propose").click()
        expect(self.el("#propose")).to_be_disabled()
        self.open_evolution()
        expect(self.el("#checks li")).to_have_text(["/words one two → 2", "Hello → Continue normal chat"])
        expect(self.el("#active-label")).to_contain_text("revision 1")
        self.el("#candidate-script summary").click()
        expect(self.el("#candidate-source")).to_have_text("return count(words)")
        self.el("#apply").click()
        expect(self.el("#active-label")).to_contain_text("revision 2")
        self.el("#active-label").click()
        self.el("#rollback").click()
        expect(self.el("#active-label")).to_contain_text("revision 3")
        expect(self.el("#active-source")).to_have_text("return original()")
        proposals = [data for name, data in self.calls if name == "evolution.propose"]
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["builderModel"], "openai/gpt-4.1-mini")
        self.assertEqual(proposals[0]["acceptance"], [dict(input="/words real check", expected="2")])
        self.assertIn(("evolution.apply", dict(id="legacy", requestId=proposals[0]["requestId"], baseRevision=1)), self.calls)
        self.assertIn(("evolution.rollback", dict(id="legacy", revision=2)), self.calls)

    def test_retry_evolution_after_unknown_delivery_and_known_failure(self):
        self.open_evolution()
        self.lose_proposal_ack = self.reject_build = True
        self.el("#requirement").fill("Count words")
        self.el("#propose").click()
        expect(self.el("#evolution-error")).to_contain_text("Delivery unconfirmed")
        self.open_evolution()
        expect(self.el("#requirement")).to_have_value("Count words")
        self.el("#propose").click()
        expect(self.el("#evolution-error")).to_have_text("Could not meet the requirement.")
        self.reject_build = False
        self.el("#propose").click()
        expect(self.el("#candidate")).to_be_visible()
        ids = [data["requestId"] for name, data in self.calls if name == "evolution.propose"]
        self.assertTrue(all("acceptance" not in data for name, data in self.calls if name == "evolution.propose"))
        self.assertEqual(ids[0], ids[1])
        self.assertNotEqual(ids[1], ids[2])

    def test_delete_requires_confirmation_and_retries_the_same_agent(self):
        self.open_panel()
        self.page.get_by_role("button", name="Details for Anterior").click()
        self.el("#edit").click()
        self.el("#delete").click()
        expect(self.el("#delete-target")).to_have_text("Anterior · legacy")
        expect(self.el("#delete-cancel")).to_be_focused()
        self.el("#delete-cancel").click()
        self.assertFalse(any(name == "agents.delete" for name, _ in self.calls))
        self.el("#delete").click()
        self.lose_delete_ack = True
        self.el("#delete-yes").click()
        expect(self.el("#delete-error")).to_contain_text("Connection lost")
        self.el("#delete-yes").click()
        expect(self.el("#launch-status")).to_have_text("Deleted legacy.")
        expect(self.el("#agents li")).to_have_count(1)
        expect(self.el("#agents")).to_contain_text("Externo")
        operations = [data for name, data in self.calls if name == "agents.delete"]
        self.assertEqual(operations[0], operations[1])

    def test_external_agents_and_older_services_preserve_existing_controls(self):
        self.management_version = None
        self.open_panel()
        self.page.get_by_role("button", name="Details for Anterior").click()
        expect(self.el("#evolve")).to_be_hidden()
        self.el("#edit").click()
        expect(self.el("#delete")).to_be_hidden()
        self.management_version = 1
        self.open_panel()
        self.el("#agents .agent").filter(has_text="Externo").click()
        expect(self.el("#evolve")).to_be_hidden()
        self.el("#edit").click()
        expect(self.el("#delete")).to_be_hidden()


if __name__ == "__main__":
    unittest.main()
