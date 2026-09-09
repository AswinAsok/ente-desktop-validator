ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY node/ /usr/local/
COPY bootstrap.sh /tmp/bootstrap.sh
RUN bash /tmp/bootstrap.sh
ENV HOME=/home/validator
WORKDIR /workspace
