def evaluate_d20(roll: int, ability_score: int, dc: int) -> dict[str, int | str]:
    if not 1 <= roll <= 20:
        raise ValueError("roll must be 1..20")
    if not 1 <= ability_score <= 30:
        raise ValueError("ability score must be 1..30")
    if not 1 <= dc <= 30:
        raise ValueError("DC must be 1..30")
    modifier = (ability_score - 10) // 2
    total = roll + modifier
    degree = "success" if total >= dc else "failure"
    return {"degree": degree, "modifier": modifier, "total": total}


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
