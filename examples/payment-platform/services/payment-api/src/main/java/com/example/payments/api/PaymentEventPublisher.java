package com.example.payments.api;

import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

/**
 * Publishes payment lifecycle events for downstream consumers.
 */
@Component
public class PaymentEventPublisher {

    static final String TOPIC = "payment.events";

    private final KafkaTemplate<String, PaymentEvent> kafkaTemplate;

    public PaymentEventPublisher(KafkaTemplate<String, PaymentEvent> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publishCreated(Payment payment) {
        PaymentEvent event = PaymentEvent.created(payment);
        kafkaTemplate.send(TOPIC, payment.id().toString(), event);
    }
}
