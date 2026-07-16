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
