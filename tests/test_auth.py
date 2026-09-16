import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ["DATABASE_URL"] = "sqlite://"
os.environ["JWT_SECRET"] = "unit-test-only-not-a-deployment-secret"

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError, ProgrammingError, SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

from routers import auth
import security


class LoginPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", poolclass=StaticPool)
        self.addCleanup(self.engine.dispose)
        with self.engine.begin() as conn:
            conn.exec_driver_sql("ATTACH DATABASE ':memory:' AS public")
            conn.connection.driver_connection.create_function("NOW", 0, lambda: "2026-09-16")
            conn.exec_driver_sql("""
                CREATE TABLE public.users_new (
                    id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT,
                    is_active BOOLEAN, created_at TEXT, full_name TEXT, email TEXT,
                    force_password_change BOOLEAN, last_login TEXT
                )
            """)
            conn.exec_driver_sql("""
                CREATE TABLE public.user_permission_grants (
                    user_id INTEGER, permission TEXT, revoked_at TEXT,
                    valid_from TEXT, valid_until TEXT
                )
            """)
            conn.execute(text("""
                INSERT INTO public.users_new (id, username, password_hash, role, is_active)
                VALUES (1, 'legacy-user', :password, 'viewer', TRUE)
            """), {"password": "legacy-password"})
        self.db = Session(self.engine)
        self.addCleanup(self.db.close)
        self.request = Request({
            "type": "http", "method": "POST", "path": "/auth/login",
            "headers": [], "client": ("127.0.0.1", 12345),
            "server": ("testserver", 80), "scheme": "http", "query_string": b"",
        })

    def test_legacy_password_upgrade_survives_login_and_audit_failure(self):
        for audit_error in (None, SQLAlchemyError("audit unavailable")):
            with self.subTest(audit_error=audit_error):
                self.db.execute(text("""
                    UPDATE public.users_new SET password_hash = 'legacy-password' WHERE id = 1
                """))
                self.db.commit()
                with patch.object(auth, "write_audit_log", side_effect=audit_error):
                    if audit_error:
                        with self.assertLogs("routers.auth", level="ERROR"):
                            result = auth.login(
                                auth.LoginIn(username="legacy-user", password="legacy-password"),
                                self.request, self.db,
                            )
                    else:
                        result = auth.login(
                            auth.LoginIn(username="legacy-user", password="legacy-password"),
                            self.request, self.db,
                        )
                self.db.close()
                with Session(self.engine) as check:
                    stored = check.execute(text(
                        "SELECT password_hash FROM public.users_new WHERE id = 1"
                    )).scalar_one()
                self.assertNotEqual(stored, "legacy-password")
                self.assertTrue(security.verify_password("legacy-password", stored))
                self.assertTrue(result["access_token"])
                self.assertEqual(result["role"], "viewer")

    def test_incorrect_password_does_not_change_stored_password(self):
        with patch.object(auth, "write_audit_log"):
            with self.assertRaises(HTTPException) as error:
                auth.login(
                    auth.LoginIn(username="legacy-user", password="wrong"),
                    self.request, self.db,
                )
        self.assertEqual(error.exception.status_code, 401)
        self.assertEqual(self.db.execute(text(
            "SELECT password_hash FROM public.users_new WHERE id = 1"
        )).scalar_one(), "legacy-password")


class PermissionTransactionTests(unittest.TestCase):
    def test_missing_legacy_table_uses_savepoint_not_outer_rollback(self):
        db = MagicMock()
        db.execute.side_effect = ProgrammingError(
            "SELECT permission", {}, SimpleNamespace(pgcode="42P01"),
        )
        with self.assertLogs("security", level="WARNING"):
            self.assertEqual(security._active_permission_grants(db, 1), set())
        db.begin_nested.assert_called_once()
        db.rollback.assert_not_called()

    def test_unexpected_database_errors_are_not_hidden_as_empty_permissions(self):
        for error in (
            OperationalError("SELECT permission", {}, Exception("connection lost")),
            ProgrammingError("SELECT permission", {}, SimpleNamespace(pgcode="42703")),
        ):
            with self.subTest(error=error):
                db = MagicMock()
                db.execute.side_effect = error
                with self.assertRaises(type(error)):
                    security._active_permission_grants(db, 1)
                db.rollback.assert_not_called()


if __name__ == "__main__":
    unittest.main()
