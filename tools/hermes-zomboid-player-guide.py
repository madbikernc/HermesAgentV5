#!/usr/bin/env python3
# Version: 1.0.0
#
# Generates skills/zomboid-admin/player-admin-guide.pdf -- the player-facing
# quick-start guide handed to a trusted player given zomboid-admin access
# (see the "Local Fork" section of skills/zomboid-admin/SKILL.md for the
# account itself). This script is the guide's source of truth; the PDF had
# none until this file was added, which is why it went stale (missing the
# newworld command) after newworld shipped in hermes-zomboid-admin-local.sh.
# Regenerate with: python3 tools/hermes-zomboid-player-guide.py
import os

from fpdf import FPDF, XPos, YPos

GUIDE_VERSION = "1.1.0"
HOST = "192.168.1.221"

TEAL = (0, 77, 66)
GRAY = (110, 110, 110)
BODY = (30, 30, 30)
RULE = (0, 77, 66)
WARN_BORDER = (176, 32, 32)
WARN_BG = (253, 235, 235)
WARN_TEXT = (140, 20, 20)
DANGER_BORDER = (150, 20, 20)
DANGER_BG = (250, 220, 220)


class Guide(FPDF):
    def header(self):
        if self.page_no() == 1:
            return
        self.set_font("Helvetica", "I", 9)
        self.set_text_color(*GRAY)
        self.cell(0, 8, "Zomboid Server Admin - Quick Start", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_draw_color(*GRAY)
        self.set_line_width(0.2)
        self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
        self.ln(4)

    def footer(self):
        self.set_y(-15)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(*GRAY)
        self.cell(0, 10, f"Project Zomboid dedicated server - {HOST}", align="C")

    def section(self, title):
        self.ln(2)
        self.set_font("Helvetica", "B", 13)
        self.set_text_color(*TEAL)
        self.cell(0, 9, title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_draw_color(*RULE)
        self.set_line_width(0.5)
        self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
        self.ln(4)

    def command(self, name, description):
        self.set_font("Courier", "B", 10.5)
        self.set_text_color(*BODY)
        self.cell(0, 6, name, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_font("Helvetica", "", 10.5)
        self.set_x(self.l_margin + 5)
        self.multi_cell(self.w - self.l_margin - self.r_margin - 5, 5.5, description)
        self.ln(1.5)

    def body(self, text, size=10.5, italic=False):
        self.set_font("Helvetica", "I" if italic else "", size)
        self.set_text_color(*BODY if not italic else GRAY)
        self.multi_cell(0, 5.5, text)
        self.ln(1)

    def callout(self, text, danger=False):
        border = DANGER_BORDER if danger else WARN_BORDER
        bg = DANGER_BG if danger else WARN_BG
        fg = WARN_TEXT if not danger else DANGER_BORDER
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(*fg)
        self.set_draw_color(*border)
        self.set_fill_color(*bg)
        self.set_line_width(0.4)
        x, y = self.l_margin, self.get_y()
        w = self.w - self.l_margin - self.r_margin
        # Measure height first by writing into a throwaway multi_cell dry run.
        lines = self.multi_cell(w - 6, 5.5, text, dry_run=True, output="LINES")
        h = 6 + len(lines) * 5.5
        self.rect(x, y, w, h, style="DF")
        self.set_xy(x + 3, y + 3)
        self.multi_cell(w - 6, 5.5, text)
        self.set_xy(x, y + h + 4)


def build():
    pdf = Guide()
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.set_margins(20, 18, 20)

    # Cover page
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 24)
    pdf.set_text_color(*TEAL)
    pdf.cell(0, 14, "Zomboid Server Admin", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Helvetica", "", 13)
    pdf.set_text_color(*GRAY)
    pdf.cell(0, 8, "Quick Start Guide", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Helvetica", "", 8)
    pdf.cell(0, 6, f"Version {GUIDE_VERSION}", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(10)
    pdf.set_font("Helvetica", "", 11)
    pdf.set_text_color(*BODY)
    pdf.multi_cell(
        0,
        6,
        "You've been given admin access to the Project Zomboid dedicated server. "
        "This guide covers everything you need to check on the server, manage "
        "players, and tweak game settings like zombie spawn rate.",
    )
    pdf.ln(6)
    pdf.set_font("Helvetica", "B", 11)
    pdf.multi_cell(0, 6, "Keep this guide handy - you don't need to memorize any of it.")

    # Page 2
    pdf.add_page()
    pdf.section("1. Logging In")
    pdf.body(
        "Your admin access is a separate account on the server, just for game "
        "administration. It cannot do anything outside of managing the Zomboid "
        "server itself."
    )
    pdf.set_font("Courier", "", 10.5)
    pdf.cell(0, 7, f"ssh zomboid-admin@{HOST}", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(1)
    pdf.body(
        "Your password will be given to you separately by whoever set up your "
        "access - don't share it with anyone else. If you're asked for a "
        "password when connecting, that's normal; type it in (it won't show "
        "on screen as you type) and press Enter."
    )
    pdf.body(
        "If you're on Windows, any terminal works (PowerShell, Command Prompt, "
        "or Windows Terminal). On Mac or Linux, use the Terminal app.",
        italic=True,
    )

    pdf.section("2. Running Commands")
    pdf.body("Once you're logged in, every command below is run like this:")
    pdf.set_font("Courier", "", 10.5)
    pdf.cell(0, 7, "/opt/zomboid/hermes-zomboid-admin-local.sh <command>", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(1)
    pdf.body("For example, to check whether the server is healthy:")
    pdf.set_font("Courier", "", 10.5)
    pdf.cell(0, 7, "/opt/zomboid/hermes-zomboid-admin-local.sh status", new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    pdf.section("3. Checking the Server")
    pdf.command("status", "Full health check: is it running, how many players, disk space, recent errors.")
    pdf.command("players", "Who is connected right now.")
    pdf.command("logins", "Every account that has ever existed, and when they last connected.")
    pdf.command("auditlog", "The last 20 kicks/bans, and who issued them.")

    # Page 3
    pdf.add_page()
    pdf.section("4. Controlling the Server")
    pdf.command("start", "Turn the server on.")
    pdf.command("stop", "Turn the server off (saves the world first).")
    pdf.command("restart", "Turn it off and back on again.")
    pdf.command("update", "Install the latest Zomboid server files from Steam, then restart.")
    pdf.callout(
        'Heads up: start, stop, restart, and update all disconnect anyone '
        'currently playing. Use "broadcast" (below) to warn people a minute '
        "or two beforehand if you can."
    )

    pdf.ln(2)
    pdf.section("5. Starting a Brand New World")
    pdf.command(
        "newworld --confirm",
        "Wipes the current map completely - every building, item, and zombie - "
        "and starts a fresh world with a new random layout. Nobody's character "
        "or progress on the current map survives this. It also disconnects "
        "anyone currently playing, the same as restart.",
    )
    pdf.body(
        "What IS kept: the whitelist, everyone's access level, and the ban "
        "list - accounts and permissions carry over into the new world "
        "untouched. The old map isn't deleted either; your admin can dig it "
        "back out if needed."
    )
    pdf.callout(
        "STOP AND THINK before using this one. It's the single most "
        "destructive command in this guide - the whole map is gone for "
        "everyone, immediately. Don't run it on your own; talk to your admin "
        "and make sure everyone playing agrees first. The --confirm at the "
        "end is a safety check, not optional decoration - the command "
        "refuses to run without it.",
        danger=True,
    )

    pdf.section("6. Managing Players")
    pdf.command("adduser <name> [password]", "Add someone to the whitelist so they're allowed to join. Password is optional.")
    pdf.command("removeuser <name>", "Remove someone from the whitelist.")
    pdf.command(
        "setaccesslevel <name> <level>",
        'Change someone\'s permissions. Levels, low to high: user, priority, '
        'observer, gm, moderator, admin. Use "admin" to make someone else an '
        "admin too.",
    )
    pdf.command("setpassword <name> <newpass>", "Reset a player's in-game password.")
    pdf.command("kick <name> [reason]", "Boot someone off right now - they can rejoin immediately.")
    pdf.command("banuser <name> [reason]", "Ban someone so they can't rejoin.")
    pdf.command("unbanuser <name>", "Lift a ban.")
    pdf.body(
        'Names go exactly as they appear in "logins" or "players" above - not '
        "their Steam name, their in-game account name.",
        italic=True,
    )

    # Page 4
    pdf.add_page()
    pdf.section("7. Changing Game Settings (Spawn Rate, Loot, etc.)")
    pdf.command("sandboxvars", "See every current game setting.")
    pdf.command("sandboxvars <name>", "See just one setting, e.g. sandboxvars PopulationMultiplier")
    pdf.command("sandboxvar <name>=<value>", "Change a setting.")
    pdf.body("A couple of the more useful ones for zombie spawn rate:")
    pdf.set_font("Courier", "", 10.5)
    pdf.set_text_color(*BODY)
    pdf.cell(0, 6.5, "sandboxvar PopulationMultiplier=1.2", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.cell(0, 6.5, "sandboxvar RespawnHours=24", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(1)
    pdf.body(
        "(higher PopulationMultiplier = more zombies; RespawnHours controls "
        "whether cleared areas repopulate over time)"
    )
    pdf.callout(
        'Heads up: Changing a game setting always restarts the server to '
        'apply it - same as "restart" above. It also automatically backs up '
        "the settings file first, so if a change turns out to be a bad idea, "
        "ask your admin to help you roll it back."
    )

    pdf.section("8. Talking to Players")
    pdf.command('broadcast "message"', "Send a message to everyone currently on the server.")
    pdf.command("save", "Save the game world right now, without restarting.")

    pdf.section("9. Good to Know")
    pdf.set_font("Helvetica", "", 10.5)
    pdf.set_text_color(*BODY)
    for line in [
        "Only change settings you actually understand - if you're not sure what something does, ask before trying it.",
        'Every action here is real and immediate - there\'s no "undo" button, though world saves and settings backups give you some safety net.',
        "If something looks broken or a command doesn't do what you expected, stop and ask your admin rather than trying more commands to fix it.",
    ]:
        pdf.set_x(pdf.l_margin)
        pdf.multi_cell(0, 5.5, f"- {line}")
    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 7.5)
    pdf.set_text_color(*GRAY)
    pdf.cell(0, 5, f"Guide version {GUIDE_VERSION}", new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    out_path = os.path.join(
        os.path.dirname(__file__), "..", "skills", "zomboid-admin", "player-admin-guide.pdf"
    )
    pdf.output(os.path.abspath(out_path))
    print(f"Wrote {os.path.abspath(out_path)}")


if __name__ == "__main__":
    build()
