import re
from pyxlsb import open_workbook
import psycopg2

XLSB = r"/mnt/data/19.01.2026 DBS COLO 2.0 LIST.xlsb"

re_left  = re.compile(r"M(?P<from_room>[\d\.]+(?:\s?S\d+)?)\/(?P<from_slot>\d+)\s*->\s*M(?P<to_room>[\d\.]+(?:\s?S\d+)?)")
re_right = re.compile(r"M(?P<to_room>[\d\.]+(?:\s?S\d+)?)\/(?P<to_slot>\d+)")

def norm_room(s: str) -> str:
    return s.replace(" ", "")  # "5.13 S1" -> "5.13S1"

rows = []
current_group_room = None
current_primary = False

with open_workbook(XLSB) as wb:
    with wb.get_sheet("Pulldownliste") as sh:
        for r in sh.rows():
            vals = [c.v for c in r]
            # Spalten: [A, B, C, D, E] (bei dir so im Sheet)
            b = vals[1]  # "M5.13 S1" oder "M5.04 S6" oder None
            c = vals[2]  # "YES"/"NO" oder None
            d = vals[3]  # "M5.04S6/9 -> M5.13"
            e = vals[4]  # "M5.13/11"

            if b:
                current_group_room = norm_room(str(b).replace("M", ""))
            if c:
                current_primary = str(c).strip().upper() == "YES"

            if not d or not e:
                continue

            m1 = re_left.search(str(d))
            m2 = re_right.search(str(e))
            if not (m1 and m2):
                continue

            from_room = norm_room(m1.group("from_room"))
            from_slot = int(m1.group("from_slot"))
            to_room   = norm_room(m2.group("to_room"))
            to_slot   = int(m2.group("to_slot"))

            rows.append((from_room, from_slot, to_room, to_slot, current_primary))

# DB insert (UPSERT optional)
conn = psycopg2.connect("dbname=... user=... password=... host=...")
cur = conn.cursor()
cur.execute("TRUNCATE public.bb_routes;")
cur.executemany("""
    INSERT INTO public.bb_routes(from_room, from_slot, to_room, to_slot, is_primary)
    VALUES (%s,%s,%s,%s,%s)
""", rows)
conn.commit()
cur.close()
conn.close()

print("Imported", len(rows), "routes")
