# -*- coding: utf-8 -*-

""" osmocom: various utilities
"""

import json
import string
import datetime
import argparse
from io import BytesIO
from typing import Optional, List, NewType

# Copyright (C) 2009-2010  Sylvain Munaut <tnt@246tNt.com>
# Copyright (C) 2021 Harald Welte <laforge@osmocom.org>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 2 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.
#

class hexstr(str):
    def __new__(cls, s: str):
        if not all(c in string.hexdigits for c in s):
            raise ValueError('Input must be hexadecimal digits only')
        return super().__new__(cls, s.lower())

    def __eq__(self, other: str) -> bool:
        return str(self) == other.lower()

    def __hash__(self):
        return hash(str(self))

    def __getitem__(self, val) -> 'hexstr':
        return hexstr(super().__getitem__(val))

    def to_bytes(self) -> bytes:
        s = str(self)
        if len(s) & 1:
            raise ValueError('Cannot convert hex string with odd number of digits')
        return h2b(s)

    @classmethod
    def from_bytes(cls, bt: bytes) -> 'hexstr':
        return cls(b2h(bt))

Hexstr = NewType('Hexstr', str)

def h2b(s: Hexstr) -> bytearray:
    """convert from a string of hex nibbles to a sequence of bytes"""
    return bytearray.fromhex(s)


def b2h(b: bytearray) -> hexstr:
    """convert from a sequence of bytes to a string of hex nibbles"""
    return hexstr(b.hex())


def h2i(s: Hexstr) -> List[int]:
    return list(h2b(s))


def i2h(s: List[int]) -> hexstr:
    return hexstr(bytes(s).hex())


def h2s(s: Hexstr) -> str:
    return ''.join([chr((int(x, 16) << 4)+int(y, 16)) for x, y in zip(s[0::2], s[1::2])
                    if int(x + y, 16) != 0xff])


def s2h(s: str) -> hexstr:
    b = bytearray()
    b.extend(map(ord, s))
    return b2h(b)


def swap_nibbles(s: Hexstr) -> hexstr:
    return hexstr(''.join([x+y for x, y in zip(s[1::2], s[0::2])]))


def rpad(s: str, l: int, c='f') -> str:
    return s + c * (l - len(s))


def lpad(s: str, l: int, c='f') -> str:
    return c * (l - len(s)) + s


def is_hex(string: str, minlen: int = 2, maxlen: Optional[int] = None) -> bool:
    if not string:
        return False
    if len(string) < minlen or minlen < 2:
        return False
    if len(string) % 2:
        return False
    if maxlen and len(string) > maxlen:
        return False
    try:
        _try_encode = h2b(string)
        return True
    except Exception:
        return False


def auto_int(x):
    return int(x, 0)


def auto_uint8(x):
    ret = int(x, 0)
    if ret < 0 or ret > 255:
        raise argparse.ArgumentTypeError('Number exceeds permitted value range (0, 255)')
    return ret


def is_hexstr(instr: str) -> hexstr:
    if not all(c in string.hexdigits for c in instr):
        raise ValueError('Input must be hexadecimal')
    if len(instr) & 1:
        raise ValueError('Input has un-even number of hex digits')
    return hexstr(instr)


def is_decimal(instr: str) -> str:
    if not instr.isdecimal():
        raise ValueError('Input must decimal')
    return instr


class JsonEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, (BytesIO, bytes, bytearray)):
            return b2h(o)
        elif isinstance(o, datetime.datetime):
            return o.isoformat()
        return json.JSONEncoder.default(self, o)


def all_subclasses(cls) -> set:
    return set(cls.__subclasses__()).union([s for c in cls.__subclasses__() for s in all_subclasses(c)])
