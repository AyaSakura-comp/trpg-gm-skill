import unittest

from trpg_gm.rules import evaluate_d100, evaluate_d20


class RuleTests(unittest.TestCase):
    def test_d20_applies_ability_modifier_against_dc(self):
        self.assertEqual(
            evaluate_d20(roll=12, ability_score=17, dc=15),
            {"degree": "success", "modifier": 3, "total": 15},
        )
        self.assertEqual(
            evaluate_d20(roll=11, ability_score=17, dc=15),
            {"degree": "failure", "modifier": 3, "total": 14},
        )

    def test_d20_ability_checks_do_not_auto_fail_or_succeed_on_natural_extremes(self):
        self.assertEqual(
            evaluate_d20(roll=1, ability_score=30, dc=5)["degree"], "success"
        )
        self.assertEqual(
            evaluate_d20(roll=20, ability_score=1, dc=30)["degree"], "failure"
        )

    def test_d100_reports_coc_degrees(self):
        self.assertEqual(evaluate_d100(1, 60), "critical")
        self.assertEqual(evaluate_d100(20, 60), "hard")
        self.assertEqual(evaluate_d100(50, 60), "success")
        self.assertEqual(evaluate_d100(90, 60), "failure")
        self.assertEqual(evaluate_d100(100, 60), "fumble")


if __name__ == "__main__":
    unittest.main()
