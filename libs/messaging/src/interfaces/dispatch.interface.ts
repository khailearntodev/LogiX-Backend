/** Persist this exact request before contacting Order; retries must reuse it. */
export interface AuthorizeOrderDispatchRequest {
  requestId: string;
  shipmentId: string;
  reservationGroupId: string;
  orderVersion: number;
  actorId: string;
}

/** An irrevocable decision, not proof that shipment dispatch or stock issue completed. */
export interface OrderDispatchGrant extends AuthorizeOrderDispatchRequest {
  orderId: string;
  grantedAt: string;
  correlationId: string;
}
