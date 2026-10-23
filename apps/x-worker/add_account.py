"""Adds one throwaway X account to the worker. Never use your main account.
You paste two cookie values from the logged-in account (steps in README.md); nothing is sent anywhere but X."""
import asyncio
import re
from pathlib import Path


def _clean(value, name):
    v = value.strip().strip('"').strip("'").rstrip(";").strip()
    v = re.sub(rf"^{name}\s*=\s*", "", v, flags=re.I)  # accepts a paste like auth_token=abc123
    if not re.fullmatch(r"[A-Za-z0-9%_\-]{20,400}", v):
        raise ValueError(f"{name} looks wrong: it should be one long string of letters and numbers with no spaces.")
    return v


def build_cookies(auth_token, ct0):
    return f"auth_token={_clean(auth_token, 'auth_token')}; ct0={_clean(ct0, 'ct0')}"


async def main():
    from twscrape import API
    api = API(str(Path(__file__).resolve().parent / "accounts.db"))
    user = input("X username of the throwaway account (without @): ").strip().lstrip("@")
    auth = input("auth_token cookie: ")
    ct0 = input("ct0 cookie: ")
    try:
        cookies = build_cookies(auth, ct0)
    except ValueError as e:
        print("\nNot saved:", e)
        return
    await api.pool.add_account(user, "x", f"{user}@example.com", "x", cookies=cookies)
    print(f"\nAdded @{user}. You can run this again later to add more accounts: the worker rotates through all of them.")
    print("Accounts the worker now knows:")
    for a in await api.pool.accounts_info():
        print(" -", a.get("username"), "| active" if a.get("active") else "| NOT active")


if __name__ == "__main__":
    asyncio.run(main())
