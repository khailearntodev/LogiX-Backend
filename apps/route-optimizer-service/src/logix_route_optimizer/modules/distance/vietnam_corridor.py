from __future__ import annotations

# Ordered South -> North waypoints along Vietnam's National Highway 1A / CT01 corridor.
# Used to keep domestic inter-regional routes strictly inside Vietnam's territory
# instead of cutting across Cambodia or Laos on global OSRM / straight-line routing.
VIETNAM_QL1A_WAYPOINTS_SOUTH_TO_NORTH: tuple[tuple[float, float], ...] = (
    (10.9333, 107.2428),  # Long Khanh, Dong Nai
    (10.9289, 108.1021),  # Phan Thiet, Binh Thuan
    (11.5643, 108.9886),  # Phan Rang, Ninh Thuan
    (12.2451, 109.1943),  # Nha Trang, Khanh Hoa
    (13.0955, 109.3209),  # Tuy Hoa, Phu Yen
    (13.7765, 109.2237),  # Quy Nhon, Binh Dinh
    (15.1205, 108.7923),  # Quang Ngai
    (16.0544, 108.2022),  # Da Nang
    (16.4637, 107.5909),  # Hue
    (16.8163, 107.1003),  # Dong Ha, Quang Tri
    (17.4689, 106.6223),  # Dong Hoi, Quang Binh
    (18.3428, 105.9057),  # Ha Tinh
    (18.6796, 105.6813),  # Vinh, Nghe An
    (19.8067, 105.7852),  # Thanh Hoa
    (20.2506, 105.9745),  # Ninh Binh
)


def min_vietnam_longitude(lat: float) -> float:
    """
    Approximate minimum longitude of Vietnam's western land border with Cambodia and Laos
    as a function of latitude (degrees North).
    """
    if lat < 10.50:
        return 104.30
    if lat < 11.20:
        return 105.00
    if lat < 11.90:
        return 105.80
    if lat < 12.50:
        return 107.10
    if lat < 14.90:
        return 107.30
    if lat < 16.15:
        return 107.15
    if lat < 16.95:
        return 106.50
    if lat < 17.85:
        return 105.65
    if lat < 18.60:
        return 105.05
    if lat < 19.85:
        return 103.85
    if lat < 20.65:
        return 104.40
    return 102.14


def is_point_in_vietnam_corridor(lat: float, lon: float) -> bool:
    """Return True if (lat, lon) lies within Vietnam's mainland/coastal corridor."""
    if not (8.35 <= lat <= 23.45 and 102.10 <= lon <= 109.60):
        return False
    return lon >= min_vietnam_longitude(lat)


def is_geojson_polyline_in_vietnam(geometry_coords: list[list[float]]) -> bool:
    """
    Check whether a GeoJSON polyline (list of [lon, lat]) stays completely inside Vietnam.
    """
    if not geometry_coords:
        return True
    for pair in geometry_coords:
        if len(pair) < 2:
            continue
        lon, lat = float(pair[0]), float(pair[1])
        if not is_point_in_vietnam_corridor(lat, lon):
            return False
    return True


def needs_vietnam_coastal_corridor(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> bool:
    """
    Return True when two domestic Vietnam coordinates span across the S-curve
    such that direct routing risks cutting through Cambodia or Laos.
    """
    if not (
        is_point_in_vietnam_corridor(lat1, lon1)
        and is_point_in_vietnam_corridor(lat2, lon2)
    ):
        return False
    low_lat = min(lat1, lat2)
    high_lat = max(lat1, lat2)
    if high_lat - low_lat < 1.4:
        return False
    # Crossing the Central Vietnam / Truong Son curve where Cambodia & Laos sit to the west
    return low_lat < 16.8 and high_lat > 11.4


def build_vietnam_corridor_waypoints(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> list[tuple[float, float]]:
    """
    Return an ordered list of (lat, lon) points starting at (lat1, lon1),
    passing through intermediate National Highway 1A waypoints, and ending at (lat2, lon2).
    """
    if not needs_vietnam_coastal_corridor(lat1, lon1, lat2, lon2):
        return [(lat1, lon1), (lat2, lon2)]

    low_lat = min(lat1, lat2) + 0.25
    high_lat = max(lat1, lat2) - 0.25

    intermediate = [
        wp
        for wp in VIETNAM_QL1A_WAYPOINTS_SOUTH_TO_NORTH
        if low_lat <= wp[0] <= high_lat
    ]
    if lat1 > lat2:
        intermediate.reverse()

    return [(lat1, lon1), *intermediate, (lat2, lon2)]
