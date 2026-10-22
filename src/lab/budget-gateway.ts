import { BudgetLedger, type BudgetRequest, type BudgetReservation, type BudgetUsage } from "./budget.js";

export interface BoundedResponse<T> {
  value: T;
  usage: BudgetUsage;
}

// The adapter must enforce the supplied cost bound at its provider boundary; this ledger cannot constrain an arbitrary API.
export class BoundedGateway {
  constructor(private readonly ledger: BudgetLedger) {}

  async execute<T>(
    request: BudgetRequest,
    call: (reservation: Readonly<BudgetReservation>) => Promise<BoundedResponse<T>>,
    options: { retry?: boolean } = {},
  ): Promise<T> {
    const reservation = Object.freeze(this.ledger.reserve(request));
    let response: BoundedResponse<T>;
    try {
      response = await call(reservation);
    } catch (error) {
      this.ledger.markUncertain(reservation.id, { failed: true, retry: options.retry });
      throw error;
    }
    let settled: BudgetReservation;
    try {
      settled = this.ledger.settle(reservation.id, { ...response.usage, retry: options.retry ?? response.usage.retry });
    } catch (error) {
      const cost = response?.usage?.costMicroUsd;
      this.ledger.markUncertain(reservation.id, {
        failed: true,
        retry: options.retry,
        observedCostMicroUsd: Number.isSafeInteger(cost) && cost >= 0 ? cost : undefined,
      });
      throw error;
    }
    if (settled.breached) throw new Error("Provider exceeded reserved bound; future calls are frozen");
    return response.value;
  }
}
