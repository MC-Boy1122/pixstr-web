#!/usr/bin/env python3
"""SEAL codec visual demo (PyQt6).

Byte-identical to the PixStr web/Expo/Rust implementations:
standard base64 body + 1-8 filler chars at PRNG positions + 4-char salt.

Run:            python3 seal_demo.py
Self-test:      python3 seal_demo.py --test
"""

import base64
import random
import sys

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QFont, QFontDatabase
from PyQt6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

SEAL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"


def make_seal_rng(seed):
    seed &= 0xFFFFFFFF
    if seed == 0:
        seed = 0x9E3779B9

    def next_():
        nonlocal seed
        seed = (seed ^ (seed << 13)) & 0xFFFFFFFF
        seed = (seed ^ (seed >> 17)) & 0xFFFFFFFF
        seed = (seed ^ (seed << 5)) & 0xFFFFFFFF
        return seed

    return next_


def seed_from_salt(salt):
    seed = 0
    for ch in salt[1:4]:
        idx = SEAL_ALPHABET.index(ch) if ch in SEAL_ALPHABET else 0
        seed = ((seed << 8) | idx) & 0xFFFFFFFF
    if seed == 0:
        seed = 0x9E3779B9
    return seed


def seal(inner):
    return "[Sealed] " + seal_payload(inner)


def seal_payload(inner):
    body = base64.b64encode(inner.encode("utf-8")).decode("ascii").rstrip("=")
    l = len(body)
    m = 1 + int(random.random() * 8)
    salt = (
        SEAL_ALPHABET[8 * int(random.random() * 8) + (m - 1)]
        + "".join(SEAL_ALPHABET[int(random.random() * 64)] for _ in range(3))
    )
    rng = make_seal_rng(seed_from_salt(salt))
    positions = sorted(rng() % (l + 1) for _ in range(m))
    fillers = []
    out = []
    fi = 0
    for i in range(l + 1):
        while fi < m and positions[fi] == i:
            f = SEAL_ALPHABET[rng() % 64]
            fillers.append((i, f))
            out.append(f)
            fi += 1
        if i < l:
            out.append(body[i])
    return {
        "body": body,
        "m": m,
        "salt": salt,
        "seed": seed_from_salt(salt),
        "positions": positions,
        "fillers": fillers,
        "sealed_body": "".join(out),
        "payload": "".join(out) + salt,
    }


def unseal_payload(s):
    cleaned = "".join(s.split())
    if len(cleaned) < 4:
        return None
    salt, received = cleaned[-4:], cleaned[:-4]
    if any(c not in SEAL_ALPHABET for c in salt):
        return None
    idx0 = SEAL_ALPHABET.index(salt[0])
    m = 1 + (idx0 % 8)
    if len(received) < m:
        return None
    l = len(received) - m
    rng = make_seal_rng(seed_from_salt(salt))
    positions = sorted(rng() % (l + 1) for _ in range(m))
    body = []
    fi = 0
    for ch in received:
        if fi < m and positions[fi] == len(body):
            fi += 1
            continue
        body.append(ch)
    if fi != m:
        return None
    body = "".join(body)
    if len(body) % 4 == 1 or not all(c in SEAL_ALPHABET for c in body):
        return None
    try:
        raw = base64.b64decode(body + "=" * ((4 - len(body) % 4) % 4), validate=True)
        return raw.decode("utf-8", errors="strict")
    except Exception:
        return None


def unseal(s):
    if s.startswith("[Sealed]"):
        return unseal_payload(s[len("[Sealed]"):].strip())
    return None


# Canonical vectors from the Rust reference implementation.
VECTORS = [
    ("D5zW", "[Base64] SGVsbG8sIFdvcmxkIQ==", "W0Juhc2U2NF0gU0dWc2BJHOHNJRmRM2Y214a0lRPbT0D5zW", "Hello, World!"),
    ("/7z/", "[JPG] aGVsbG8=", "/cW0pQFRL10gYHUdWc2JHhODo0S/7z/", "hello"),
    ("ABAB", "[Hex] 68656c6c6f", "W0hleF0gNjg2wNTZjNmM2ZgABAB", "hello"),
    ("9+/9", "xK#0@zVx+q", "etEsxjMEB6Vn5gir0cQc9+/9", None),
]


def _force_salt(salt):
    idx = SEAL_ALPHABET.index
    m = 1 + (idx(salt[0]) % 8)
    k = (idx(salt[0]) - (m - 1)) / 8
    return [(m - 1) / 8, (k + 0.5) / 8, idx(salt[1]) / 64, idx(salt[2]) / 64, idx(salt[3]) / 64]


def self_test():
    failures = 0
    for salt, inner, expected, _ in VECTORS:
        real = random.random
        seq = _force_salt(salt)
        random.random = lambda: seq.pop(0) if seq else 0.5
        got = seal_payload(inner)
        random.random = real
        if got["payload"] != expected:
            failures += 1
            print(f"FAIL encode {salt}: {got['payload']} != {expected}")
        if unseal_payload(expected) != inner:
            failures += 1
            print(f"FAIL decode {salt}")
    if failures == 0:
        print("ALL PASS — 4 canonical vectors match Rust/JS")
    else:
        print(f"{failures} FAILURES")
    return failures


class SealDemo(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("SEAL codec demo")
        self.resize(760, 640)
        mono = QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont)
        mono.setPointSize(10)
        self.mono = mono

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)

        root.addWidget(self._label("1. Message", bold=True))
        self.input = QLineEdit("Hello, World!")
        self.input.setFont(mono)
        root.addWidget(self.input)

        btns = QHBoxLayout()
        seal_btn = QPushButton("Seal (show steps)")
        seal_btn.clicked.connect(self.do_seal)
        unseal_btn = QPushButton("Unseal (paste below)")
        unseal_btn.clicked.connect(self.do_unseal)
        btns.addWidget(seal_btn)
        btns.addWidget(unseal_btn)
        root.addLayout(btns)

        self.steps = QTextEdit()
        self.steps.setReadOnly(True)
        self.steps.setFont(mono)
        root.addWidget(self._label("2. Steps", bold=True))
        root.addWidget(self.steps)

        root.addWidget(self._label("3. Sealed output (for the app / online decoders)", bold=True))
        self.output = QTextEdit()
        self.output.setReadOnly(True)
        self.output.setFont(mono)
        self.output.setMaximumHeight(64)
        root.addWidget(self.output)

    @staticmethod
    def _label(text, bold=False):
        lab = QLabel(text)
        if bold:
            lab.setStyleSheet("font-weight: 700; margin-top: 6px;")
        return lab

    @staticmethod
    def _hl(body, fillers, salt=None, pad=""):
        """body with fillers in red, salt in blue."""
        parts = []
        for i, ch in enumerate(body):
            if fillers and i == fillers[0][0]:
                _, f = fillers.pop(0)
                parts.append(f'<span style="color:#e5484d;font-weight:800;text-decoration:underline">{f}</span>')
            parts.append(ch)
        text = "".join(parts)
        if salt is not None:
            text += f'<span style="color:#2f6fdb;font-weight:800">{pad}{salt}</span>'
        return text

    def do_seal(self):
        inner = f"[Base64] {base64.b64encode(self.input.text().encode('utf-8')).decode('ascii')}"
        s = seal_payload(inner)
        lines = [
            f'<b>inner</b>        {inner}',
            f'<b>body</b>         {s["body"]}  ({len(s["body"])} chars)',
            f'<b>salt</b>         <span style="color:#2f6fdb;font-weight:800">{s["salt"]}</span>  '
            f'm={s["m"]} filler(s), PRNG seed={s["seed"]}',
            f'<b>positions</b>    {s["positions"]}',
            f'<b>sealed body</b>  {self._hl(s["sealed_body"], list(s["fillers"]))}  '
            f'({len(s["sealed_body"])} chars)',
            f'<b>+ salt</b>       {self._hl(s["sealed_body"], list(s["fillers"]), salt=s["salt"], pad="")}',
            f'<b>final</b>        [Sealed] {self._hl(s["sealed_body"], list(s["fillers"]), salt=s["salt"])}',
            "",
            "red = random filler (invisible to online decoders), blue = salt (the key).",
        ]
        self.steps.setHtml("<br>".join(lines))
        self.output.setPlainText("[Sealed] " + s["payload"])

    def do_unseal(self):
        text = self.output.toPlainText().strip()
        if not text:
            self.output.setPlainText("Encode something first.")
            return
        inner = unseal(text)
        if inner is None:
            self.output.setPlainText("Not a valid sealed message.")
            return
        decoded = unseal_payload(inner) if inner.startswith("[") else None
        s = seal_payload(inner)
        lines = [
            f'<b>input</b>       {self._hl(s["sealed_body"], list(s["fillers"]), salt=s["salt"])}',
            f'<b>salt</b>        last 4 chars = <span style="color:#2f6fdb;font-weight:800">{s["salt"]}</span> → seed {s["seed"]}',
            f'<b>positions</b>   same PRNG → remove chars at {s["positions"]}',
            f'<b>body</b>        {s["body"]}',
            f'<b>base64</b>      + padding → decode → {inner}',
            f'<b>result</b>      {decoded or inner}',
        ]
        self.steps.setHtml("<br>".join(lines))


def main():
    if "--test" in sys.argv:
        sys.exit(1 if self_test() else 0)
    app = QApplication(sys.argv)
    win = SealDemo()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()