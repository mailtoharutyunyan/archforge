package com.example.payments.worker;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Consumes payment lifecycle events and settles them.
 */
@Component
public class PaymentEventListener {

    private final SettlementService settlementService;
    private final IdempotencyStore idempotencyStore;

    public PaymentEventListener(SettlementService settlementService, IdempotencyStore idempotencyStore) {
        this.settlementService = settlementService;
        this.idempotencyStore = idempotencyStore;
    }

    @KafkaListener(topics = "payment.events", groupId = "payment-worker")
    public void onPaymentEvent(PaymentEvent event) {
        if (!idempotencyStore.markProcessed(event.paymentId().toString())) {
            return;
        }
        settlementService.settle(event);
    }
}
