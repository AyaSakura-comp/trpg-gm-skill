import unittest

from trpg_gm.catalog import _REQUIRED_SCHEMA, _has_trpg_schema


class _Rows:
    def __init__(self, values):
        self.values = values

    def fetchall(self):
        return self.values


class _SchemaConnection:
    def __init__(self, schema):
        self.schema = schema

    def execute(self, statement, parameters=()):
        if "sqlite_master" in statement:
            return _Rows([(table,) for table in self.schema])
        table = parameters[0]
        return _Rows([(column,) for column in self.schema.get(table, set())])


class CatalogSchemaTests(unittest.TestCase):
    def test_complete_trpg_signature_is_accepted(self):
        schema = {table: set(columns) for table, columns in _REQUIRED_SCHEMA.items()}
        self.assertTrue(_has_trpg_schema(_SchemaConnection(schema)))

    def test_foreign_rooms_table_without_full_trpg_signature_is_rejected(self):
        schema = {"rooms": {"id", "system", "status"}}
        self.assertFalse(_has_trpg_schema(_SchemaConnection(schema)))

    def test_trpg_table_missing_required_column_is_rejected(self):
        schema = {table: set(columns) for table, columns in _REQUIRED_SCHEMA.items()}
        schema["events"].remove("payload_json")
        self.assertFalse(_has_trpg_schema(_SchemaConnection(schema)))


if __name__ == "__main__":
    unittest.main()
