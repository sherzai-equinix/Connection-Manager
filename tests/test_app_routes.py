"""Exercise the actual export-alias route without running production startup SQL."""

import ast
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

os.environ["DATABASE_URL"] = "sqlite://"
os.environ["JWT_SECRET"] = "unit-test-only-not-a-deployment-secret"

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from database import get_db
from security import create_access_token, require_permissions_for_write


class ExportAliasTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "app.py"
        tree = ast.parse(source.read_text(encoding="utf-8-sig"))
        alias = next(node for node in tree.body
                     if isinstance(node, ast.FunctionDef) and node.name == "cc_export_alias")
        self.app = FastAPI()
        self.db = object()

        def test_db():
            yield self.db

        self.app.dependency_overrides[get_db] = test_db
        self.export = Mock(return_value={"exported": True})
        namespace = {
            "app": self.app, "Depends": Depends, "Session": Session, "get_db": get_db,
            "settings": SimpleNamespace(api_prefix="/api/v1"),
            "rbac_deps": [Depends(require_permissions_for_write("audit:write"))],
            "_cc_export_fn": self.export,
        }
        exec(compile(ast.Module(body=[alias], type_ignores=[]), str(source), "exec"), namespace)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def test_export_alias_requires_login(self):
        response = self.client.get("/api/v1/cross_connects/export")
        self.assertEqual(response.status_code, 401)
        self.export.assert_not_called()

    def test_export_alias_allows_authenticated_viewer_and_forwards_filters(self):
        token = create_access_token(subject="reader", role="viewer", user_id=1)
        with patch("security.get_user_by_username", return_value={
            "id": 1, "username": "reader", "role": "viewer", "is_active": True,
        }):
            response = self.client.get(
                "/api/v1/cross_connects/export",
                params={"status": "all", "q": "customer"},
                headers={"Authorization": f"Bearer {token}"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"exported": True})
        self.export.assert_called_once_with(status="all", q="customer", db=self.db)

    def test_export_alias_rejects_expired_or_invalid_token(self):
        response = self.client.get(
            "/api/v1/cross_connects/export", headers={"Authorization": "Bearer invalid"},
        )
        self.assertEqual(response.status_code, 401)
        self.export.assert_not_called()


if __name__ == "__main__":
    unittest.main()
