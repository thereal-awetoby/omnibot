import asyncio, unittest
from datetime import datetime
from types import SimpleNamespace as NS
import worker, add_account

async def _co(v): return v

def tw(i, text, links=(), rt=False, qt=None, date=None):
    return NS(id=i, id_str=str(i), rawContent=text, links=[NS(url=u) for u in links], retweetedTweet=NS() if rt else None, quotedTweet=qt, date=date or datetime(2026, 10, 23, 8, 0))

class FakeApi:
    def __init__(self, data, fail=()):
        self.data, self.fail = data, set(fail)
    async def user_by_login(self, h):
        return NS(id=h) if h in self.data else None
    async def user_tweets(self, uid, limit=20):
        if uid in self.fail:
            raise RuntimeError("rate limited")
        for t in self.data[uid]:
            yield t

class FakeDb:
    def __init__(self, handles): self._h, self.saved, self.stat = handles, {}, {}
    async def handles(self): return self._h
    async def save(self, h, rows): self.saved[h] = rows
    async def status(self, h, ok, err): self.stat[h] = (ok, err)

class T(unittest.TestCase):
    def test_row_conversion(self):
        r = worker.tweet_to_row(tw(5, "buy MINT", links=["https://pump.fun/coin/abc"], qt=NS(rawContent="quoted CA", links=[NS(url="https://x.com/q")])))
        self.assertEqual(r["id"], "5"); self.assertIn("quoted CA", r["text"]); self.assertEqual(r["urls"], ["https://pump.fun/coin/abc", "https://x.com/q"])
        self.assertFalse(r["is_retweet"]); self.assertIsNotNone(r["created_at"].tzinfo)
        self.assertTrue(worker.tweet_to_row(tw(6, "rt", rt=True))["is_retweet"])
        # older twscrape name for the text field
        self.assertEqual(worker.tweet_to_row(NS(id=7, text="hi", links=None, date=None))["text"], "hi")
    def test_round_isolates_failures_and_saves(self):
        api = FakeApi({"a": [tw(1, "x"), tw(2, "y")], "b": []}, fail={"b"})
        db = FakeDb(["a", "b", "ghost"])
        async def nosleep(_): pass
        n = asyncio.run(worker.run_round(api, db, {}, sleep=nosleep))
        self.assertEqual(n, 3); self.assertEqual([r["id"] for r in db.saved["a"]], ["1", "2"])
        self.assertEqual(db.stat["a"], (True, None)); self.assertFalse(db.stat["b"][0]); self.assertEqual(db.stat["b"][1], "rate limited")
        self.assertEqual(db.stat["ghost"], (False, "no such X account"))
    def test_round_pacing(self):
        self.assertEqual(worker.round_period(1, 1), 22.5)
        self.assertAlmostEqual(worker.round_period(3, 1), 67.5)
        self.assertAlmostEqual(worker.round_period(3, 3), 22.5)
        self.assertEqual(worker.round_period(0, None), 22.5)
        self.assertEqual(worker.round_period(1, 10), 15.0)
    def test_dsn(self):
        d, ssl = worker.clean_dsn("postgresql://u:p@ep-x.neon.tech/db?sslmode=require&channel_binding=require")
        self.assertEqual(d, "postgresql://u:p@ep-x.neon.tech/db"); self.assertEqual(ssl, "require")
        self.assertEqual(worker.clean_dsn("postgresql://u:p@localhost:5544/db")[1], None)
    def test_cookie_check(self):
        ok = add_account.build_cookies("a" * 40, "b" * 64)
        self.assertEqual(ok, "auth_token=" + "a" * 40 + "; ct0=" + "b" * 64)
        with self.assertRaises(ValueError): add_account.build_cookies("short", "b" * 64)
        with self.assertRaises(ValueError): add_account.build_cookies("a" * 40, "x y")
        self.assertEqual(add_account.build_cookies('auth_token=' + "A1" * 20 + ';', ' "' + "b" * 30 + '" '), "auth_token=" + "A1" * 20 + "; ct0=" + "b" * 30)
    def test_error_wording(self):
        c = worker.classify_error
        self.assertEqual(c(RuntimeError("HTTP 429 Too Many Requests")), "rate limited")
        self.assertEqual(c(RuntimeError("Account locked (326)")), "account locked - need new cookies")
        self.assertEqual(c(RuntimeError("401 Could not authenticate you")), "authentication failed")
        self.assertEqual(c(RuntimeError("no such X account")), "no such X account")
        self.assertEqual(c(RuntimeError("No account available for queue UserTweets")), "no usable X account - need new cookies")
        self.assertEqual(c(asyncio.TimeoutError()), "timed out (X slow or limiting)")
    def test_no_usable_account_is_reported_for_every_handle(self):
        api = FakeApi({"a": []}); api.pool = NS(accounts_info=lambda: _co([{"username": "t", "active": False}]))
        db = FakeDb(["a", "b"])
        asyncio.run(worker.run_round(api, db, {}, sleep=lambda _: _co(None)))
        self.assertEqual(db.stat["a"], (False, "no usable X account - need new cookies")); self.assertEqual(db.saved, {})

if __name__ == "__main__": unittest.main()
