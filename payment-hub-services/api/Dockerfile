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
