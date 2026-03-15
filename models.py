"""Data models for the Drendel Gap Scanner."""

from dataclasses import dataclass, field, asdict
from datetime import date, datetime
from typing import Optional


@dataclass
class BarData:
    """OHLCV bar data for a single period."""
    symbol: str
    bar_date: date | datetime  # date for daily/weekly, datetime for intraday
    open: float
    high: float
    low: float
    close: float
    volume: int = 0

    def to_dict(self):
        d = asdict(self)
        d["bar_date"] = self.bar_date.isoformat()
        return d


@dataclass
class GapZone:
    """A support or resistance gap zone."""
    symbol: str
    gap_type: str  # 'support', 'resistance', 'untested_support', 'untested_resistance'
    zone_top: float
    zone_bottom: float
    original_top: float
    original_bottom: float
    created_date: date
    test_count: int = 0
    reduction_count: int = 0
    status: str = "active"  # 'active', 'reduced', 'filled'
    id: str = ""  # unique identifier

    def __post_init__(self):
        if not self.id:
            self.id = f"{self.symbol}_{self.created_date}_{self.gap_type}_{self.original_bottom:.2f}"

    @property
    def zone_size(self) -> float:
        return self.zone_top - self.zone_bottom

    @property
    def zone_size_pct(self) -> float:
        mid = (self.zone_top + self.zone_bottom) / 2
        if mid == 0:
            return 0.0
        return (self.zone_size / mid) * 100

    @property
    def age_days(self) -> int:
        return (date.today() - self.created_date).days

    @property
    def is_untested(self) -> bool:
        return self.gap_type.startswith("untested_")

    @property
    def base_type(self) -> str:
        """Returns 'support' or 'resistance' regardless of tested status."""
        return self.gap_type.replace("untested_", "")

    def to_dict(self):
        d = asdict(self)
        d["created_date"] = self.created_date.isoformat()
        d["zone_size"] = round(self.zone_size, 4)
        d["zone_size_pct"] = round(self.zone_size_pct, 2)
        d["age_days"] = self.age_days
        d["is_untested"] = self.is_untested
        d["base_type"] = self.base_type
        return d


@dataclass
class Alert:
    """An alert generated when price enters or approaches a gap zone."""
    symbol: str
    alert_type: str  # 'support_entry', 'resistance_entry', 'untested_approach'
    current_price: float
    zone: GapZone
    penetration_pct: float  # how deep into the zone (0-100%)
    distance_pct: float  # distance from zone boundary (for proximity alerts)
    timestamp: datetime = field(default_factory=datetime.now)
    is_first_test: bool = False

    def to_dict(self):
        d = {
            "symbol": self.symbol,
            "alert_type": self.alert_type,
            "current_price": round(self.current_price, 2),
            "penetration_pct": round(self.penetration_pct, 2),
            "distance_pct": round(self.distance_pct, 2),
            "timestamp": self.timestamp.isoformat(),
            "is_first_test": self.is_first_test,
            "zone": self.zone.to_dict(),
        }
        return d


@dataclass
class ScannerStatus:
    """Current scanner state."""
    running: bool = False
    last_scan: Optional[str] = None
    last_eod_update: Optional[str] = None
    symbol_count: int = 0
    zone_count: int = 0
    alert_count: int = 0
    error: Optional[str] = None
    initialized: bool = False

    def to_dict(self):
        return asdict(self)
