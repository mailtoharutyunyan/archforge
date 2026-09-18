package com.example.payments.worker;

import java.time.Duration;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/**
 * Remembers which events were already processed. This is the dependency the
 * architecture model forgot to mention: Redis is used here but not declared.
 */
@Component
public class IdempotencyStore {

    private static final Duration TTL = Duration.ofHours(24);

    private final StringRedisTemplate redis;

    public IdempotencyStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** Returns true the first time a key is seen. */
    public boolean markProcessed(String key) {
        Boolean first = redis.opsForValue().setIfAbsent("processed:" + key, "1", TTL);
        return Boolean.TRUE.equals(first);
    }
}
