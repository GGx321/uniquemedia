"""Names a Caveat wght=600 instance "Caveat SemiBold" (family "Caveat").

Caveat's STAT table has no axis value for wght=600, so fontTools' --update-name-table
refuses it; the other instances get their names from STAT. Usage: fix-caveat-names.py IN OUT
"""
import sys

from fontTools.ttLib import TTFont

NAMES = {1: "Caveat SemiBold", 2: "Regular", 4: "Caveat SemiBold", 6: "Caveat-SemiBold", 16: "Caveat", 17: "SemiBold"}

font = TTFont(sys.argv[1], recalcTimestamp=False)
for name_id, value in NAMES.items():
    font["name"].setName(value, name_id, 3, 1, 0x409)
    font["name"].setName(value, name_id, 1, 0, 0)
font.save(sys.argv[2])
