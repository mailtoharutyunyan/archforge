package com.example.payments.worker;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public record PaymentEvent(String type, UUID paymentId, BigDecimal amount, String currency, Instant occurredAt) {
}
