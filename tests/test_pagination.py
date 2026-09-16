"""Pagination regressions using disposable, in-memory SQLite databases only.

Run with: python -m unittest discover -s tests -p test_pagination.py
SQLite adapts ILIKE to LIKE for these ASCII fixtures and NULL::text to CAST.
No application database, startup hooks, or external services are used.
"""

import os
import unittest
from datetime import date, datetime, timedelta

os.environ["DATABASE_URL"] = "sqlite://"
os.environ["JWT_SECRET"] = "unit-test-only-not-a-deployment-secret"

from fastapi import HTTPException
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from routers import cross_connects, migration_audit


SEARCH_FIELDS = (
    "serial", "switch_name", "switch_port", "a_patchpanel_id", "a_port_label",
    "backbone_out_instance_id", "backbone_out_port_label",
    "backbone_in_instance_id", "backbone_in_port_label", "customer_port_label",
    "system_name", "rack_code",
)


class SyntheticDatabaseTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", poolclass=StaticPool)
        self.addCleanup(self.engine.dispose)

        @event.listens_for(self.engine, "before_cursor_execute", retval=True)
        def sqlite_syntax(conn, cursor, statement, parameters, context, executemany):
            return (
                statement.replace(" ILIKE ", " LIKE ").replace(
                    "NULL::text", "CAST(NULL AS TEXT)"
                ),
                parameters,
            )

        with self.engine.begin() as conn:
            conn.exec_driver_sql("ATTACH DATABASE ':memory:' AS public")
            conn.exec_driver_sql("ATTACH DATABASE ':memory:' AS information_schema")
            conn.exec_driver_sql("""
                CREATE TABLE information_schema.columns (
                    table_schema TEXT, table_name TEXT, column_name TEXT
                )
            """)
            cc_columns = ", ".join(f"{column} TEXT" for column in SEARCH_FIELDS)
            conn.exec_driver_sql(f"""
                CREATE TABLE public.cross_connects (
                    id INTEGER PRIMARY KEY, status TEXT, created_at TEXT,
                    customer_patchpanel_id INTEGER, z_pp_number TEXT, {cc_columns}
                )
            """)
            conn.exec_driver_sql("""
                CREATE TABLE public.kw_tasks (
                    id INTEGER PRIMARY KEY, type TEXT, status TEXT,
                    line_id INTEGER, line1_id INTEGER, line2_id INTEGER, created_at TEXT
                )
            """)
            conn.exec_driver_sql("""
                CREATE TABLE public.patchpanel_instances (
                    id INTEGER PRIMARY KEY, instance_id TEXT
                )
            """)
            conn.exec_driver_sql("""
                CREATE TABLE public.patchpanel_ports (
                    id INTEGER PRIMARY KEY, patchpanel_id INTEGER,
                    port_label TEXT, connected_to TEXT, status TEXT
                )
            """)
        self.db = Session(self.engine)
        self.addCleanup(self.db.close)

    def insert(self, table, **values):
        columns = ", ".join(values)
        placeholders = ", ".join(f":{column}" for column in values)
        self.db.execute(
            text(f"INSERT INTO public.{table} ({columns}) VALUES ({placeholders})"),
            values,
        )


class CrossConnectPaginationTests(SyntheticDatabaseTest):
    def seed(self, count=5107):
        start = datetime(2026, 9, 16)
        self.db.execute(text("""
            INSERT INTO public.cross_connects
                (id, status, created_at, serial, system_name,
                 backbone_in_instance_id, backbone_in_port_label,
                 backbone_out_instance_id, backbone_out_port_label)
            VALUES
                (:id, 'active', :created_at, :serial, 'MATCH customer',
                 'stored-in', 'in-port', 'stored-out', 'out-port')
        """), [
            {
                "id": i,
                "created_at": (start + timedelta(seconds=i)).isoformat(" "),
                "serial": f"SER-{i}",
            }
            for i in range(1, count + 1)
        ])

    def pending(self, task_id, line_id=None, **kwargs):
        self.insert("kw_tasks", **{
            "id": task_id, "type": "move", "status": "pending_move",
            "line_id": line_id, "created_at": "2026-09-16 12:00:00", **kwargs,
        })

    def listing(self, **kwargs):
        return cross_connects.list_cross_connects(**{
            "status": "all", "date_from": None, "date_to": None, "q": None,
            "limit": 200, "offset": 0, "db": self.db, **kwargs,
        })

    def test_more_than_5000_rows_are_counted_and_pageable(self):
        self.seed()
        for status in ("all", "active"):
            with self.subTest(status=status):
                result = self.listing(status=status, offset=5000, limit=50)
                self.assertEqual(result["total"], 5107)
                self.assertEqual(
                    [row["id"] for row in result["items"]], list(range(107, 57, -1))
                )
                item = result["items"][0]
                self.assertEqual(item["backbone_in_instance_id"], "stored-out")
                self.assertEqual(item["backbone_out_instance_id"], "stored-in")
                self.assertEqual(item["backbone_in_port_label"], "out-port")
                self.assertEqual(item["backbone_out_port_label"], "in-port")

    def test_out_of_range_page_retains_full_total(self):
        self.seed()
        result = self.listing(offset=6000)
        self.assertEqual(result["total"], 5107)
        self.assertEqual(result["items"], [])

    def test_more_than_5000_pending_overrides_are_counted_and_pageable(self):
        self.seed()
        self.db.execute(text("""
            INSERT INTO public.kw_tasks (id, type, status, line_id, created_at)
            SELECT id, 'move', 'pending_move', id, created_at
            FROM public.cross_connects
        """))
        result = self.listing(status="pending_move", offset=5000, limit=500)
        self.assertEqual(result["total"], 5107)
        self.assertEqual(
            [row["id"] for row in result["items"]], list(range(107, 0, -1))
        )
        self.assertTrue(all(row["status"] == "pending_move" for row in result["items"]))
        self.assertEqual(self.listing(status="active")["total"], 0)

    def test_combined_dates_search_and_pending_filter_precede_pagination(self):
        self.seed()
        for line_id, created_at in (
            (1, "2026-09-16 00:00:00"),
            (3, "2026-09-16 23:59:59"),
            (4, "2026-09-17 00:00:00"),
            (5, "2026-09-15 23:59:59"),
        ):
            self.db.execute(text("""
                UPDATE public.cross_connects SET created_at = :created_at WHERE id = :id
            """), {"id": line_id, "created_at": created_at})
        self.db.execute(text("""
            UPDATE public.cross_connects SET system_name = 'unrelated' WHERE id = 6
        """))
        for line_id in range(1, 7):
            self.pending(line_id, line_id)
        filters = {
            "date_from": date(2026, 9, 16), "date_to": date(2026, 9, 16),
            "q": "  mAtCh  ",
        }
        result = self.listing(status="pending_move", offset=1, limit=1, **filters)
        self.assertEqual(result["total"], 3)
        self.assertEqual([row["id"] for row in result["items"]], [2])
        self.assertEqual(result["items"][0]["status"], "pending_move")
        result = self.listing(status="pending_move", **filters)
        self.assertEqual([row["id"] for row in result["items"]], [3, 2, 1])
        result = self.listing(status="active", offset=5000, limit=500, **filters)
        self.assertEqual(result["total"], 5101)
        self.assertEqual(
            [row["id"] for row in result["items"]], list(range(107, 6, -1))
        )
        self.assertEqual(self.listing(**filters)["total"], 5104)

    def test_pending_priority_types_statuses_and_deinstalled_protection(self):
        self.seed(12)
        stored_statuses = {
            2: "PENDING_SERIAL", 3: "Deinstalled", 4: "ACTIVE",
            5: "pending_move", 6: None, 8: "Active", 9: "Pending_Move", 11: None,
        }
        for line_id, status in stored_statuses.items():
            self.db.execute(text("""
                UPDATE public.cross_connects SET status = :status WHERE id = :id
            """), {"id": line_id, "status": status})
        self.pending(100, 1, created_at="2026-09-15 12:00:00")
        self.pending(1, 1, type="deinstall", status="pending_deinstall")
        self.pending(2, 1)  # Same timestamp: higher task ID wins.
        self.pending(3, 2, type="deinstall", status="pending_deinstall")
        self.pending(
            4, type="path_move", status="pending_path_move", line1_id=3, line2_id=4
        )
        self.pending(5, 5, type="install", status="pending_install")
        self.pending(
            6, type="PATH_MOVE", status="pending_path_move", line1_id=6, line2_id=7
        )
        self.pending(7, 4, status="done")
        self.pending(8, 8, status="PENDING_MOVE")
        self.pending(9, 10, type="unknown")
        self.pending(10, 11, status="pending_install")
        expected = {
            "active": [12, 10, 8], "pending_move": [9, 5, 1],
            "pending_deinstall": [2], "pending_path_move": [7, 6, 4],
            "pending_install": [11], "deinstalled": [3], "pending_serial": [],
        }
        for status, ids in expected.items():
            with self.subTest(status=status):
                result = self.listing(status=status)
                self.assertEqual(result["total"], len(ids))
                self.assertEqual([row["id"] for row in result["items"]], ids)
                for row in result["items"]:
                    self.assertEqual(row["status"].lower(), status)
        result = self.listing()
        self.assertEqual(result["total"], 12)
        by_id = {row["id"]: row for row in result["items"]}
        self.assertEqual(by_id[3]["status"], "Deinstalled")
        self.assertEqual(by_id[8]["status"], "Active")
        self.assertEqual(by_id[9]["status"], "Pending_Move")
        self.assertEqual(by_id[1]["status"], "pending_move")

    def test_zero_line_id_is_not_overridden(self):
        self.insert("cross_connects", id=0, status="active", created_at="2026-09-16")
        self.pending(1, 0)
        self.assertEqual(self.listing(status="active")["total"], 1)
        self.assertEqual(self.listing(status="pending_move")["total"], 0)

    def test_all_search_fields_and_blank_search(self):
        for i, field in enumerate(SEARCH_FIELDS, 1):
            self.insert("cross_connects", **{
                "id": i, "status": "active", "created_at": "2026-09-16",
                field: f"needle-{field}-end",
            })
        for i, field in enumerate(SEARCH_FIELDS, 1):
            with self.subTest(field=field):
                result = self.listing(q=f"  NEEDLE-{field.upper()}-END  ")
                self.assertEqual(result["total"], 1)
                self.assertEqual([row["id"] for row in result["items"]], [i])
        self.assertEqual(self.listing(q="   ")["total"], len(SEARCH_FIELDS))
        self.assertEqual(self.listing(q="absent")["total"], 0)

    def test_missing_optional_tasks_table_still_lists(self):
        self.seed(2)
        self.db.execute(text("DROP TABLE public.kw_tasks"))
        result = self.listing(status="active")
        self.assertEqual(result["total"], 2)
        self.assertEqual([row["id"] for row in result["items"]], [2, 1])

    def test_unexpected_task_query_errors_are_not_hidden(self):
        self.seed(2)
        self.db.execute(text("ALTER TABLE public.kw_tasks DROP COLUMN line2_id"))
        with self.assertRaises(HTTPException) as error:
            self.listing(status="active")
        self.assertEqual(error.exception.status_code, 500)

    def test_equal_creation_times_have_stable_id_order_across_pages(self):
        self.seed(4)
        self.db.execute(text(
            "UPDATE public.cross_connects SET created_at = '2026-09-16 12:00:00'"
        ))
        self.assertEqual(
            [row["id"] for row in self.listing(limit=2)["items"]], [4, 3],
        )
        self.assertEqual(
            [row["id"] for row in self.listing(limit=2, offset=2)["items"]], [2, 1],
        )

    def test_empty_database_and_invalid_status(self):
        result = self.listing(status="pending_move")
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["items"], [])
        with self.assertRaises(HTTPException) as error:
            self.listing(status="unknown")
        self.assertEqual(error.exception.status_code, 400)


class MigrationAuditPaginationTests(SyntheticDatabaseTest):
    def setUp(self):
        super().setUp()
        columns = """
            source_file source_row customer_name system_name room rack_code
            switch_name switch_port logical_name a_pp_raw a_pp_number a_port_label
            a_eqx_port z_pp_raw z_pp_number z_port_label z_eqx_port
            pp1_raw pp1_number pp1_port_label pp1_eqx_port
            pp2_raw pp2_number pp2_port_label pp2_eqx_port
            product_id serial_number backbone_in_instance_id backbone_in_port_label
            backbone_out_instance_id backbone_out_port_label audit_status audited_by
            audited_at linked_cc_id
        """.split()
        self.db.execute(text(
            "CREATE TABLE public.migration_audit_lines (id INTEGER PRIMARY KEY, "
            + ", ".join(f"{column} TEXT" for column in columns) + ")"
        ))
        self.db.execute(text("""
            INSERT INTO information_schema.columns VALUES
                ('public', 'migration_audit_lines', 'logical_name')
        """))

    def seed(self):
        rows = [
            {"id": 1, "serial_number": " A ", "switch_name": "old"},
            {"id": 2, "serial_number": "A", "switch_name": "new"},
            {"id": 3, "serial_number": "B"},
            {
                "id": 4, "product_id": " P-1 ", "a_pp_number": "single-a",
                "z_pp_number": "old-z",
            },
            {
                "id": 5, "product_id": "P-1", "a_pp_number": "single-a",
                "z_pp_number": "new-z",
            },
            {
                "id": 6, "serial_number": "C",
                "a_pp_number": "clean-a", "z_pp_number": "clean-z",
            },
            {
                "id": 7, "switch_name": "fallback", "a_pp_number": "single-a",
                "z_pp_number": "tech-z",
            },
            {
                "id": 8, "switch_name": "fallback", "a_pp_number": "single-a",
                "z_pp_number": "tech-z",
            },
            {"id": 9, "serial_number": "A", "audit_status": "audited"},
        ]
        for row in rows:
            self.insert("migration_audit_lines", **{
                "audit_status": "imported", "a_pp_number": "duplicate-a",
                "a_port_label": "1", "z_pp_number": "duplicate-z", "z_port_label": "1",
                "backbone_in_instance_id": "bb-in", "backbone_in_port_label": "1",
                "backbone_out_instance_id": "bb-out", "backbone_out_port_label": "1",
                **row,
            })

    def listing(self, **kwargs):
        return migration_audit.list_audit_lines(**{
            "status": "imported", "page": 1, "page_size": 100,
            "view": "current", "db": self.db, **kwargs,
        })

    def test_current_total_and_pages_follow_dedup_and_conflict_order(self):
        self.seed()
        expected_pages = ([2, 3], [5, 8], [6], [])
        for page, ids in enumerate(expected_pages, 1):
            with self.subTest(page=page):
                result = self.listing(page=page, page_size=2)
                self.assertEqual(result["total"], 5)
                self.assertEqual(result["total_pages"], 3)
                self.assertEqual(result["page"], page)
                self.assertEqual(result["page_size"], 2)
                self.assertEqual([row["id"] for row in result["items"]], ids)
                self.assertEqual(
                    result["counts"], {"errors_both": 2, "errors_single": 2, "clean": 1}
                )
                self.assertEqual(result["dedup"], {
                    "total_imported": 8, "current_lines": 5, "discarded_old": 3,
                })
        by_id = {row["id"]: row for row in self.listing()["items"]}
        self.assertEqual(by_id[2]["event_type"], "Line Move")
        self.assertEqual(by_id[5]["event_type"], "Z-Update")
        self.assertEqual(by_id[8]["event_type"], "Update")
        self.assertEqual(by_id[2]["history_count"], 2)
        self.assertEqual(by_id[5]["group_key"], "product:P-1")
        self.assertTrue(by_id[6]["ready"])
        self.assertFalse(by_id[2]["ready"])

    def test_all_view_paginates_every_row_after_global_conflict_analysis(self):
        self.seed()
        ids = []
        for page in range(1, 4):
            result = self.listing(view="all", page=page, page_size=3)
            self.assertEqual(result["total"], 8)
            self.assertEqual(result["total_pages"], 3)
            self.assertEqual(result["view"], "all")
            self.assertEqual(
                result["counts"], {"errors_both": 5, "errors_single": 2, "clean": 1}
            )
            self.assertEqual(result["dedup"]["current_lines"], 5)
            ids.extend(row["id"] for row in result["items"])
        self.assertEqual(ids, [1, 2, 3, 7, 8, 4, 5, 6])
        result = self.listing(view="all", page=4, page_size=3)
        self.assertEqual(result["items"], [])
        self.assertEqual(result["total"], 8)

    def test_status_filter_applies_before_grouping(self):
        self.seed()
        for view in ("current", "all"):
            with self.subTest(view=view):
                result = self.listing(status="audited", view=view, page_size=1)
                self.assertEqual(result["total"], 1)
                self.assertEqual([row["id"] for row in result["items"]], [9])
                self.assertEqual(result["items"][0]["history_count"], 1)
                self.assertEqual(result["items"][0]["event_type"], "Install")
                self.assertEqual(result["dedup"]["total_imported"], 1)

    def test_empty_view_and_legacy_page_normalization(self):
        for view in ("current", "all"):
            with self.subTest(view=view):
                result = self.listing(view=view, page=0, page_size=0)
                self.assertEqual(result["total"], 0)
                self.assertEqual(result["total_pages"], 1)
                self.assertEqual(result["items"], [])
                self.assertEqual(result["page"], 1)
                self.assertEqual(result["page_size"], 100)
                self.assertEqual(sum(result["counts"].values()), 0)
        self.seed()
        result = self.listing(status="invalid", view="invalid")
        self.assertEqual(result["view"], "current")
        self.assertEqual(result["total"], 5)
        self.assertEqual(self.listing(status="rejected")["total"], 0)

    def test_legacy_schema_without_logical_name(self):
        self.seed()
        self.db.execute(text("DELETE FROM information_schema.columns"))
        result = self.listing(page_size=1)
        self.assertEqual(result["total"], 5)
        self.assertIsNone(result["items"][0]["logical_name"])


if __name__ == "__main__":
    unittest.main()
