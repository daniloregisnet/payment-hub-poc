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
)

func main() {
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/enqueue-settlement", enqueueHandler)
	http.HandleFunc("/status", statusHandler)

	log.Println("Payment Queue Service listening on :8003")
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
	fmt.Fprintf(w, `{"service":"payment-queue","queue_size":%d,"max_queue":%d,"rate_limit":"10/sec"}\n`, size, maxQueue)
}

func enqueueHandler(w http.ResponseWriter, r *http.Request) {
	// Sem gate de taxa aqui de propósito — a fila (maxQueue) já é o limite que o cenário de
	// Backpressure quer demonstrar. Um rate limiter de 10/s represando a entrada, com 3s de
	// retenção por item, estabiliza a ocupação em ~30 (10 * 3s pela Lei de Little) — nunca
	// alcança maxQueue=50, então o 429 nunca dispara, não importa quantas requisições cheguem.
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
	fmt.Fprintf(w, `{"service":"payment-queue","status":"enqueued","settlement_id":"settle_xyz","queue_size":%d}\n`, queueSize)
}
