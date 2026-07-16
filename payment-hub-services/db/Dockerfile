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
