"""Three small functions used as PCP's test fixture."""

TRUE_VALUES = {"1", "true", "yes"}


def clamp(x: float, lo: float, hi: float) -> float:
    """Limit x to the range [lo, hi]."""
    if lo > hi:
        raise ValueError("lo must be <= hi")
    return max(lo, min(x, hi))


def parse_bool(value: str | None) -> bool:
    """Interpret a config string as a boolean."""
    if value is None:
        return False
    return value.strip().lower() in TRUE_VALUES


def safe_div(a: float, b: float, default: float = 0.0) -> float:
    """Divide a by b, returning default when b is zero."""
    try:
        return a / b
    except ZeroDivisionError:
        return default
