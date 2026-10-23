import asyncio, unittest
from datetime import datetime
from types import SimpleNamespace as NS
import worker, add_account

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
        self.assertEqual(db.stat["a"], (True, None)); self.assertFalse(db.stat["b"][0]); self.assertIn("rate limited", db.stat["b"][1])
        self.assertEqual(db.stat["ghost"], (False, "no such X account"))
    def test_dsn(self):
        d, ssl = worker.clean_dsn("postgresql://u:p@ep-x.neon.tech/db?sslmode=require&channel_binding=require")
        self.assertEqual(d, "postgresql://u:p@ep-x.neon.tech/db"); self.assertEqual(ssl, "require")
        self.assertEqual(worker.clean_dsn("postgresql://u:p@localhost:5544/db")[1], None)
    def test_cookie_check(self):
        ok = add_account.build_cookies("a" * 40, "b" * 64)
        self.assertEqual(ok, "auth_token=" + "a" * 40 + "; ct0=" + "b" * 64)
        with self.assertRaises(ValueError): add_account.build_cookies("short", "b" * 64)
        with self.assertRaises(ValueError): add_account.build_cookies("a" * 40, "x y")

if __name__ == "__main__": unittest.main()
