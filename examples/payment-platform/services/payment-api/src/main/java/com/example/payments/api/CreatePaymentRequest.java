package com.example.payments.api;

import java.math.BigDecimal;

public record CreatePaymentRequest(BigDecimal amount, String currency) {
}
