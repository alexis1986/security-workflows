FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN adduser -D -u 10001 app
USER 10001
HEALTHCHECK --interval=30s --timeout=3s CMD ["true"]
CMD ["sleep", "infinity"]
