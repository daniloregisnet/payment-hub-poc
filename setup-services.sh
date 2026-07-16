#!/bin/bash

# Create directories
mkdir -p payment-hub-services/{api,cache,db,queue}
cd payment-hub-services

# ============================================
# API SERVICE
# ============================================
cat > api/main.go << 'EOF'
package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
)

func main() {
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/process-payment", processPaymentHandler)
	http.HandleFunc("/check-fraud", checkFraudHandler)

	log.Println("Payment Hub API Service listening on :8000")
	log.Fatal(http.ListenAndServe(":8000", nil))
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "OK\n")
}

func processPaymentHandler(w http.ResponseWriter, r *http.Request) {
	delay := r.URL.Query().Get("delay")
	errFlag := r.URL.Query().Get("error")

	if delay != "" {
		if d, err := strconv.Atoi(delay); err == nil {
			time.Sleep(time.Duration(d) * time.Millisecond)
		}
	}

	if errFlag == "true" {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"error":"payment processing failed"}\n`)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"service":"payment-api","status":"processing","transaction_id":"txn_12345","amount":100.00,"currency":"BRL"}\n`)
}

func checkFraudHandler(w http.ResponseWriter, r *http.Request) {
	resp, err := http.Get("http://payment-cache/check-transaction-history")
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"error":"failed to check fraud database"}\n`)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"service":"payment-api","fraud_check":true,"cache_response":%s}\n`, string(body))
}
EOF

cat > api/Dockerfile << 'EOF'
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY main.go .
RUN go mod init payment-api
RUN go build -o api main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/api .
EXPOSE 8000
CMD ["./api"]
EOF

# ============================================
# CACHE SERVICE
# ============================================
cat > cache/main.go << 'EOF'
package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
)

func main() {
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/check-transaction-history", checkHistoryHandler)
	http.HandleFunc("/get-card-limit", getCardLimitHandler)

	log.Println("Cache Service (Transaction Cache) listening on :8001")
	log.Fatal(http.ListenAndServe(":8001", nil))
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "OK\n")
}

func checkHistoryHandler(w http.ResponseWriter, r *http.Request) {
	delay := r.URL.Query().Get("delay")
	errFlag := r.URL.Query().Get("error")

	if delay != "" {
		if d, err := strconv.Atoi(delay); err == nil {
			time.Sleep(time.Duration(d) * time.Millisecond)
		}
	}

	if errFlag == "true" {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"error":"cache unavailable"}\n`)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"service":"cache","status":"ok","recent_transactions":5,"fraud_risk":"low","hit_rate":0.92}\n`)
}

func getCardLimitHandler(w http.ResponseWriter, r *http.Request) {
	resp, err := http.Get("http://payment-db/get-chargeback-history")
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"error":"failed to fetch from DB"}\n`)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"service":"cache","card_limit":5000.00,"db_response":%s}\n`, string(body))
}
EOF

cat > cache/Dockerfile << 'EOF'
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY main.go .
RUN go mod init payment-cache
RUN go build -o cache main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/cache .
EXPOSE 8001
CMD ["./cache"]
EOF

# ============================================
# DB SERVICE
# ============================================
cat > db/main.go << 'EOF'
package main

import (
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"
)

func main() {
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/get-chargeback-history", chargebackHandler)
	http.HandleFunc("/check-fraud-score", fraudScoreHandler)

	log.Println("DB Service (Fraud Database) listening on :8002")
	log.Fatal(http.ListenAndServe(":8002", nil))
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "OK\n")
}

func chargebackHandler(w http.ResponseWriter, r *http.Request) {
	delay := r.URL.Query().Get("delay")
	errFlag := r.URL.Query().Get("error")

	if delay != "" {
		if d, err := strconv.Atoi(delay); err == nil {
			time.Sleep(time.Duration(d) * time.Millisecond)
		}
	}

	if errFlag == "true" {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"error":"database connection failed"}\n`)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"service":"fraud-db","status":"ok","chargebacks":0,"disputes":2,"fraud_confirmed":1,"confidence":0.98}\n`)
}

func fraudScoreHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"service":"fraud-db","fraud_score":25,"risk_level":"low","last_fraud":1626192000}\n`)
}
EOF

cat > db/Dockerfile << 'EOF'
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY main.go .
RUN go mod init payment-db
RUN go build -o db main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/db .
EXPOSE 8002
CMD ["./db"]
EOF

# ============================================
# QUEUE SERVICE
# ============================================
cat > queue/main.go << 'EOF'
package main

import (
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

var (
	queueMutex sync.Mutex
	queueSize  int = 0
	maxQueue   int = 50
	rateLimitCh = time.Tick(100 * time.Millisecond)
)

func main() {
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/enqueue-settlement", enqueueHandler)
	http.HandleFunc("/status", statusHandler)

	log.Println("Settlement Queue Service listening on :8003")
	log.Fatal(http.ListenAndServe(":8003", nil))
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "OK\n")
}

func statusHandler(w http.ResponseWriter, r *http.Request) {
	queueMutex.Lock()
	size := queueSize
	queueMutex.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"service":"settlement-queue","queue_size":%d,"max_queue":%d,"rate_limit":"10/sec"}\n`, size, maxQueue)
}

func enqueueHandler(w http.ResponseWriter, r *http.Request) {
	<-rateLimitCh

	queueMutex.Lock()
	defer queueMutex.Unlock()

	if queueSize >= maxQueue {
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprintf(w, `{"error":"settlement queue full","queue_size":%d,"max_queue":%d}\n`, queueSize, maxQueue)
		return
	}

	queueSize++

	go func() {
		time.Sleep(3 * time.Second)
		queueMutex.Lock()
		queueSize--
		queueMutex.Unlock()
		log.Printf("Settlement processed. Queue size now: %d\n", queueSize)
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	fmt.Fprintf(w, `{"service":"settlement-queue","status":"enqueued","settlement_id":"settle_xyz","queue_size":%d}\n`, queueSize)
}
EOF

cat > queue/Dockerfile << 'EOF'
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY main.go .
RUN go mod init payment-queue
RUN go build -o queue main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/queue .
EXPOSE 8003
CMD ["./queue"]
EOF

# ============================================
# BUILD IMAGES
# ============================================
echo "Building Docker images..."

cd api && docker build -t payment-api:latest . && cd ..
cd cache && docker build -t payment-cache:latest . && cd ..
cd db && docker build -t payment-db:latest . && cd ..
cd queue && docker build -t payment-queue:latest . && cd ..

echo "Done! Verifying images..."
docker images | grep payment-

echo "✅ All services built successfully!"
