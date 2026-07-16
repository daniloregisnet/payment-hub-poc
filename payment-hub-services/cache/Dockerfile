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
