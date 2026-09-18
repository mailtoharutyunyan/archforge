package com.example.payments.api;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public record PaymentEvent(String type, UUID paymentId, BigDecimal amount, String currency, Instant occurredAt) {

    public static PaymentEvent created(Payment payment) {
        return new PaymentEvent("PAYMENT_CREATED", payment.id(), payment.amount(), payment.currency(), Instant.now());
    }
}
