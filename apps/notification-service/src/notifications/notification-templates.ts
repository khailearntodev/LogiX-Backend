export interface RenderedNotificationTemplate {
  title: string;
  body: string;
  link: string | null;
}

export function renderOrderPendingStockTemplate(
  orderId: string,
): RenderedNotificationTemplate {
  return {
    title: 'Đơn hàng đang thiếu tồn kho',
    body: `Đơn hàng ${orderId} chưa đủ tồn kho để xử lý.`,
    link: `/orders/${orderId}`,
  };
}

export function renderTripDispatchedTemplate(
  tripId: string,
): RenderedNotificationTemplate {
  return {
    title: 'Chuyến giao đã được điều phối',
    body: `Chuyến giao ${tripId} đã được điều phối cho tài xế.`,
    link: '/driver/trips',
  };
}

export function renderDeliveryFailedTemplate(
  stopId: string,
): RenderedNotificationTemplate {
  return {
    title: 'Giao hàng thất bại',
    body: `Điểm giao ${stopId} giao thất bại.`,
    link: '/transport',
  };
}

export function renderDeliveryCompletedTemplate(
  stopId: string,
): RenderedNotificationTemplate {
  return {
    title: 'Giao hàng hoàn tất',
    body: `Điểm giao ${stopId} đã hoàn tất.`,
    link: '/transport',
  };
}
