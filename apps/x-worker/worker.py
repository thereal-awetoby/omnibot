"""Omni X worker: the only program that talks to X.

It reads the posts of every account people /follow in the Scan bot (table x_follows) with twscrape and a throwaway
X account, and saves them in the database (table x_feed). The Scan bot reads that table and makes the calls, so
calls, PnL cards and the leaderboard work exactly as for any other call. If this worker stops, only X reading stops.
"""
import asyncio
import logging
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

log = logging.getLogger("omni-x-worker")

CHECK_EVERY = int(os.getenv("X_CHECK_SECONDS", "0"))        # 0 = automatic (see round_period); a number forces that many seconds
SECONDS_PER_REQUEST = 22.5  # X allows about 40 timeline reads per 15 minutes per X account: one read every ~22s per account
PER_ACCOUNT_PAUSE = float(os.getenv("X_PAUSE_SECONDS", "4"))  # polite gap between two accounts
FETCH_TIMEOUT = int(os.getenv("X_FETCH_TIMEOUT", "90"))
TWEETS_PER_CHECK = 20
KEEP_DAYS = 3


def load_env():
    """Reads DATABASE_URL from the bots' .env (two folders up) unless it is already set."""
    if os.getenv("DATABASE_URL"):
        return
    env = Path(__file__).resolve().parents[2] / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k == "DATABASE_URL":
            os.environ[k] = v


def clean_dsn(url):
    """asyncpg does not accept every option a Neon link carries (channel_binding...). Returns (dsn, ssl)."""
    parts = urlsplit(url)
    opts = parse_qs(parts.query)
    wants_ssl = (opts.get("sslmode", [""])[0] in ("require", "verify-full", "verify-ca")) or (
        parts.hostname not in (None, "localhost", "127.0.0.1")
    )
    dsn = f"{parts.scheme}://{parts.netloc}{parts.path}"
    return dsn, ("require" if wants_ssl else None)


def tweet_to_row(tw):
    """One twscrape tweet -> the plain dict we store. Tolerant: different twscrape versions name fields differently."""
    text = getattr(tw, "rawContent", None) or getattr(tw, "text", None) or ""
    urls = []
    for link in (getattr(tw, "links", None) or []):
        u = getattr(link, "url", None) or getattr(link, "tcourl", None)
        if u:
            urls.append(str(u))
    qt = getattr(tw, "quotedTweet", None)
    if qt is not None:  # a quote post: the quoted text and links may hold the address too
        text += "\n" + (getattr(qt, "rawContent", None) or "")
        for link in (getattr(qt, "links", None) or []):
            u = getattr(link, "url", None)
            if u:
                urls.append(str(u))
    date = getattr(tw, "date", None)
    if isinstance(date, datetime) and date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    return {
        "id": str(getattr(tw, "id_str", None) or tw.id),
        "text": text,
        "urls": urls,
        "created_at": date,
        "is_retweet": getattr(tw, "retweetedTweet", None) is not None,
    }


def classify_error(e):
    """A short, plain reason the Scan bot can show in /following. Never the raw X text."""
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)):
        return "timed out (X slow or limiting)"
    m = f"{e.__class__.__name__} {e}".lower()
    if "no such x account" in m or "not found" in m or "suspended" in m:
        return "no such X account"
    if "locked" in m or "326" in m or "suspend" in m:
        return "account locked - need new cookies"
    if "429" in m or "rate limit" in m or "too many" in m:
        return "rate limited"
    if "no account available" in m or "noaccount" in m or "no active" in m:
        return "no usable X account - need new cookies"
    if "401" in m or "403" in m or "authenticat" in m or "unauthor" in m or "forbidden" in m or "login" in m:
        return "authentication failed"
    return (str(e) or e.__class__.__name__)[:120]


async def active_accounts(api):
    """How many X accounts in twscrape's pool can be used (None if this twscrape version cannot tell)."""
    try:
        info = await api.pool.accounts_info()
    except Exception:
        return None
    return sum(1 for a in info if (a.get("active") if isinstance(a, dict) else getattr(a, "active", False)))


async def fetch_handle(api, handle, uid_cache):
    """The latest posts of one account. Raises if the account does not exist or X refuses."""
    uid = uid_cache.get(handle)
    if uid is None:
        user = await api.user_by_login(handle)
        if not user:
            raise RuntimeError("no such X account")
        uid = uid_cache[handle] = user.id
    rows = []
    async for tw in api.user_tweets(uid, limit=TWEETS_PER_CHECK):
        rows.append(tweet_to_row(tw))
        if len(rows) >= TWEETS_PER_CHECK:
            break
    return rows


def round_period(handles, accounts):
    """Seconds between the starts of two rounds: as fast as the X accounts allow, never faster (a rate-limited
    account only makes everything slower). More throwaway accounts in the pool = a shorter wait."""
    if CHECK_EVERY > 0:
        return CHECK_EVERY
    return max(15.0, SECONDS_PER_REQUEST * max(handles, 1) / max(accounts or 1, 1))


async def run_round(api, db, uid_cache, sleep=asyncio.sleep):
    handles = await db.handles()
    if not handles:
        return 0
    usable = await active_accounts(api)
    if usable == 0:  # nothing to read with: say so for every account instead of waiting on X
        log.error("NO usable X account in the pool - add fresh cookies with add-account.bat")
        for h in handles:
            await db.status(h, False, "no usable X account - need new cookies")
        return len(handles)
    ok_n = bad_n = 0
    for h in handles:
        try:
            rows = await asyncio.wait_for(fetch_handle(api, h, uid_cache), FETCH_TIMEOUT)
            await db.save(h, rows)
            await db.status(h, True, None)
            ok_n += 1
            log.info("@%s: OK, %d posts saved", h, len(rows))
        except Exception as e:  # one account failing never stops the others
            msg = classify_error(e)
            bad_n += 1
            log.warning("@%s: FAILED - %s", h, msg)
            try:
                await db.status(h, False, msg)
            except Exception as e2:
                log.error("could not save status: %s", e2)
        await sleep(PER_ACCOUNT_PAUSE)
    log.info("round done: %d ok, %d failed, X accounts in use: %s", ok_n, bad_n, "?" if usable is None else usable)
    return len(handles)


class PgDb:
    def __init__(self, pool):
        self.pool = pool

    @classmethod
    async def connect(cls, url):
        import asyncpg
        dsn, ssl = clean_dsn(url)
        pool = await asyncpg.create_pool(dsn, ssl=ssl, min_size=1, max_size=3, command_timeout=30)
        db = cls(pool)
        await db.ensure()
        return db

    async def ensure(self):  # same tables the Scan bot creates; safe to run twice
        async with self.pool.acquire() as c:
            await c.execute("""CREATE TABLE IF NOT EXISTS x_follows (chat_id BIGINT NOT NULL, handle TEXT NOT NULL, added_by BIGINT,
                added_by_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_tweet_id TEXT, PRIMARY KEY (chat_id, handle))""")
            await c.execute("""CREATE TABLE IF NOT EXISTS x_feed (handle TEXT NOT NULL, tweet_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
                urls TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ, is_retweet BOOLEAN NOT NULL DEFAULT false,
                seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (handle, tweet_id))""")
            await c.execute("""CREATE TABLE IF NOT EXISTS x_feed_status (handle TEXT PRIMARY KEY, checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                ok BOOLEAN NOT NULL DEFAULT false, error TEXT)""")

    async def handles(self):
        async with self.pool.acquire() as c:
            return [r["handle"] for r in await c.fetch("SELECT DISTINCT handle FROM x_follows ORDER BY handle")]

    async def save(self, handle, rows):
        if not rows:
            return
        async with self.pool.acquire() as c:
            async with c.transaction():
                for r in rows:
                    await c.execute(
                        """INSERT INTO x_feed (handle, tweet_id, text, urls, created_at, is_retweet) VALUES ($1,$2,$3,$4,$5,$6)
                           ON CONFLICT (handle, tweet_id) DO UPDATE SET text = EXCLUDED.text, urls = EXCLUDED.urls""",
                        handle, r["id"], r["text"], r["urls"], r["created_at"], r["is_retweet"])
                await c.execute("DELETE FROM x_feed WHERE handle = $1 AND seen_at < now() - ($2 || ' days')::interval", handle, str(KEEP_DAYS))

    async def status(self, handle, ok, error):
        async with self.pool.acquire() as c:
            await c.execute(
                """INSERT INTO x_feed_status (handle, checked_at, ok, error) VALUES ($1, now(), $2, $3)
                   ON CONFLICT (handle) DO UPDATE SET checked_at = now(), ok = $2, error = $3""", handle, ok, error)


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore"):  # one line per X request is just noise
        logging.getLogger(noisy).setLevel(logging.WARNING)
    load_env()
    url = os.getenv("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL was not found. Run this from the omnibot folder that has the .env file.")
    from twscrape import API  # imported here so the tests do not need it
    api = API(str(Path(__file__).resolve().parent / "accounts.db"))
    if not await api.pool.accounts_info():
        sys.exit("No X account added yet. Double-click add-account.bat first.")
    db = await PgDb.connect(url)
    log.info("Omni X worker running. Press Ctrl+C to stop.")
    uid_cache = {}
    loop = asyncio.get_event_loop()
    while True:
        started = loop.time()
        n = 0
        try:
            n = await run_round(api, db, uid_cache)
            if n == 0:
                log.info("Nobody is followed yet. Use /follow @name in a group.")
        except Exception as e:
            log.error("round failed: %s", e)
        period = round_period(n, await active_accounts(api))
        await asyncio.sleep(max(3.0, period - (loop.time() - started)))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
