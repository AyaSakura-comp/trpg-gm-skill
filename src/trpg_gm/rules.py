def evaluate_d100(roll: int, target: int) -> str:
    if not 1 <= roll <= 100 or not 0 <= target <= 100:
        raise ValueError("roll must be 1..100 and target must be 0..100")
    if roll == 1:
        return "critical"
    if roll == 100 or (target < 50 and roll >= 96):
        return "fumble"
    if roll <= target // 5:
        return "extreme"
    if roll <= target // 2:
        return "hard"
    if roll <= target:
        return "success"
    return "failure"
