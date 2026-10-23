"""Adds one throwaway X account to the worker. Never use your main account.
You paste two cookie values from the logged-in account (steps in README.md); nothing is sent anywhere but X."""
import asyncio
import re
from pathlib import Path


def build_cookies(auth_token, ct0):
    a, c = auth_token.strip().strip('"'), ct0.strip().strip('"')
    if not re.fullmatch(r"[0-9a-fA-F]{30,64}", a):
        raise ValueError("auth_token should be a long string of letters and numbers (about 40 characters).")
    if not re.fullmatch(r"[0-9a-zA-Z]{30,300}", c):
        raise ValueError("ct0 should be a long string of letters and numbers.")
    return f"auth_token={a}; ct0={c}"


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
    print(f"\nAdded @{user}. Accounts the worker now knows:")
    for a in await api.pool.accounts_info():
        print(" -", a.get("username"), "| active" if a.get("active") else "| NOT active")


if __name__ == "__main__":
    asyncio.run(main())
