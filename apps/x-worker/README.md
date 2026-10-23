# Omni X worker

Reads the posts of the X accounts people `/follow` in the Scan bot, using one throwaway X account (never your main one).
The Scan bot then calls any token address found, like every other call. If this worker is off, only X reading stops.

One time (Windows): install Python from python.org (tick "Add python.exe to PATH"), then double-click:
1. `setup.bat`  (installs the parts)
2. `add-account.bat`  (asks for the throwaway account's username, `auth_token` and `ct0`)

Getting the two cookies: open x.com in Chrome logged in as the throwaway account -> press F12 -> Application ->
Cookies -> https://x.com -> copy the Value of `auth_token` and of `ct0`. Paste them when asked. Log out of nothing: just close the tab
(logging out in the browser kills the cookies).

Every day: start the Scan bot (`npm run scan`) and double-click `run.bat`. Keep both windows open.
Check in the group with `/following`: it should say the account is being read.

Safe habits: 1 throwaway account is enough for a few followed accounts; do not follow more than ~10.
If `/following` says the worker is not running, `run.bat` is closed. If it says X refused, the throwaway account was locked: make
a new one and run `add-account.bat` again.
