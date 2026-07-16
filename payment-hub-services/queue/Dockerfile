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
