from __future__ import annotations

import uuid
from logix_route_optimizer.modules.routing.schemas import LocationIn, StopIn, VehicleIn

DEFAULT_DEPOT = LocationIn(
    name="Kho Tổng Miền Nam (Tân Bình)",
    address="32 Phan Thúc Duyện, Phường 4, Quận Tân Bình, TP.HCM",
    lat=10.8015,
    lng=106.6542,
)

DEFAULT_VEHICLE = VehicleIn(
    plate_number="59C-123.45",
    capacity_weight_kg=1000.0,
    capacity_volume_m3=8.0,
)

# Standard 5-stop delivery tour in central & inner Ho Chi Minh City
DEFAULT_SAMPLE_STOPS = [
    StopIn(
        trip_stop_id=uuid.UUID("11111111-1111-1111-1111-111111111111"),
        stop_name="Đại lý Minh Khai",
        address="120 Lý Thường Kiệt, Phường 7, Quận 10, TP.HCM",
        lat=10.7725,
        lng=106.6690,
        demand_weight_kg=150.0,
        demand_volume_m3=1.2,
        sequence=1,
    ),
    StopIn(
        trip_stop_id=uuid.UUID("22222222-2222-2222-2222-222222222222"),
        stop_name="Cửa hàng Bách Hóa Xanh",
        address="45 Trương Định, Phường 6, Quận 3, TP.HCM",
        lat=10.7812,
        lng=106.6845,
        demand_weight_kg=200.0,
        demand_volume_m3=1.5,
        sequence=2,
    ),
    StopIn(
        trip_stop_id=uuid.UUID("33333333-3333-3333-3333-333333333333"),
        stop_name="Siêu thị Mini Mart",
        address="88 Nguyễn Du, Phường Bến Nghé, Quận 1, TP.HCM",
        lat=10.7769,
        lng=106.7009,
        demand_weight_kg=180.0,
        demand_volume_m3=1.0,
        sequence=3,
    ),
    StopIn(
        trip_stop_id=uuid.UUID("44444444-4444-4444-4444-444444444444"),
        stop_name="Đại lý Hàng Tiêu Dùng",
        address="19 Bạch Đằng, Phường 24, Quận Bình Thạnh, TP.HCM",
        lat=10.8030,
        lng=106.7112,
        demand_weight_kg=220.0,
        demand_volume_m3=1.8,
        sequence=4,
    ),
    StopIn(
        trip_stop_id=uuid.UUID("55555555-5555-5555-5555-555555555555"),
        stop_name="Cửa hàng Tiện Lợi Phú Nhuận",
        address="105 Phan Xích Long, Phường 2, Quận Phú Nhuận, TP.HCM",
        lat=10.7985,
        lng=106.6810,
        demand_weight_kg=100.0,
        demand_volume_m3=0.8,
        sequence=5,
    ),
]
