import unittest

from trpg_gm.rules import evaluate_d100


class RuleTests(unittest.TestCase):
    def test_d100_reports_coc_degrees(self):
        self.assertEqual(evaluate_d100(1, 60), "critical")
        self.assertEqual(evaluate_d100(20, 60), "hard")
        self.assertEqual(evaluate_d100(50, 60), "success")
        self.assertEqual(evaluate_d100(90, 60), "failure")
        self.assertEqual(evaluate_d100(100, 60), "fumble")


if __name__ == "__main__":
    unittest.main()
