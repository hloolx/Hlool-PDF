package library

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"path"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
)

// S3Options configures the S3 (or S3-compatible) backend. Credentials come from
// the standard AWS chain, never from here.
type S3Options struct {
	Bucket         string
	Region         string
	Endpoint       string
	Prefix         string
	ForcePathStyle bool
	// SSE is "none", "AES256" or "aws:kms"; KMSKeyID applies when SSE is
	// "aws:kms".
	SSE      string
	KMSKeyID string
	// ChecksumWhenSupported keeps the SDK's default integrity checksums. When
	// false (the default) checksums are only attached when an operation
	// strictly requires them, which is what most non-AWS stores expect.
	ChecksumWhenSupported bool
}

// S3Store keeps the user library in an S3 bucket. Objects are encrypted per the
// configured SSE mode. Keys are {prefix}/users/{uid}/... derived server-side.
type S3Store struct {
	client   *s3.Client
	bucket   string
	prefix   string
	sse      s3types.ServerSideEncryption // empty == omit the header
	kmsKeyID string
	locks    keyedMutex
}

// NewS3Store builds an S3-backed library store.
func NewS3Store(ctx context.Context, opts S3Options) (*S3Store, error) {
	loadOpts := []func(*awsconfig.LoadOptions) error{}
	if opts.Region != "" {
		loadOpts = append(loadOpts, awsconfig.WithRegion(opts.Region))
	}
	// The SDK defaults to calculating CRC checksums + aws-chunked encoding on
	// every upload; many S3-compatible stores (R2, B2, some MinIO) reject that.
	// Default to "when required" for portability; opt back in for real AWS.
	if !opts.ChecksumWhenSupported {
		loadOpts = append(loadOpts,
			awsconfig.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
			awsconfig.WithResponseChecksumValidation(aws.ResponseChecksumValidationWhenRequired),
		)
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, err
	}
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if opts.Endpoint != "" {
			o.BaseEndpoint = aws.String(opts.Endpoint)
		}
		o.UsePathStyle = opts.ForcePathStyle
	})
	store := &S3Store{
		client:   client,
		bucket:   opts.Bucket,
		prefix:   strings.Trim(opts.Prefix, "/"),
		kmsKeyID: opts.KMSKeyID,
	}
	switch opts.SSE {
	case "AES256":
		store.sse = s3types.ServerSideEncryptionAes256
	case "aws:kms":
		store.sse = s3types.ServerSideEncryptionAwsKms
	}
	return store, nil
}

// putObject writes one object, applying the configured server-side-encryption
// mode. Centralising this keeps every write consistent (and SSE-toggle-able).
func (s *S3Store) putObject(ctx context.Context, key, contentType string, body []byte) error {
	in := &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(body),
		ContentType: aws.String(contentType),
	}
	if s.sse != "" {
		in.ServerSideEncryption = s.sse
		if s.sse == s3types.ServerSideEncryptionAwsKms && s.kmsKeyID != "" {
			in.SSEKMSKeyId = aws.String(s.kmsKeyID)
		}
	}
	_, err := s.client.PutObject(ctx, in)
	return err
}

func (s *S3Store) key(parts ...string) string {
	all := make([]string, 0, len(parts)+2)
	if s.prefix != "" {
		all = append(all, s.prefix)
	}
	all = append(all, "users")
	all = append(all, parts...)
	return path.Join(all...)
}

func (s *S3Store) stampKey(uid, id string) string     { return s.key(uid, "stamps", id) }
func (s *S3Store) stampMetaKey(uid, id string) string { return s.key(uid, "stamps", id+".json") }
func (s *S3Store) libraryKey(uid string) string       { return s.key(uid, "library.json") }

func (s *S3Store) ListStamps(ctx context.Context, uid string) ([]StampMeta, error) {
	if !safeSegment(uid) {
		return nil, errInvalidID
	}
	prefix := s.key(uid, "stamps") + "/"
	paginator := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{
		Bucket: aws.String(s.bucket),
		Prefix: aws.String(prefix),
	})
	out := []StampMeta{}
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, obj := range page.Contents {
			key := aws.ToString(obj.Key)
			if !strings.HasSuffix(key, ".json") {
				continue
			}
			meta, err := s.getMetaByKey(ctx, key)
			if err != nil {
				continue
			}
			out = append(out, meta)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (s *S3Store) PutStamp(ctx context.Context, uid string, meta StampMeta, data []byte) error {
	if !safeSegment(uid) || !safeSegment(meta.ID) {
		return errInvalidID
	}
	if err := s.putObject(ctx, s.stampKey(uid, meta.ID), meta.Mime, data); err != nil {
		return err
	}
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return s.putObject(ctx, s.stampMetaKey(uid, meta.ID), "application/json", metaBytes)
}

func (s *S3Store) GetStamp(ctx context.Context, uid, id string) (StampMeta, io.ReadCloser, error) {
	if !safeSegment(uid) || !safeSegment(id) {
		return StampMeta{}, nil, errInvalidID
	}
	meta, err := s.StampMeta(ctx, uid, id)
	if err != nil {
		return StampMeta{}, nil, err
	}
	obj, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.stampKey(uid, id)),
	})
	if err != nil {
		if isNotFound(err) {
			return StampMeta{}, nil, ErrStampNotFound
		}
		return StampMeta{}, nil, err
	}
	return meta, obj.Body, nil
}

func (s *S3Store) StampMeta(ctx context.Context, uid, id string) (StampMeta, error) {
	if !safeSegment(uid) || !safeSegment(id) {
		return StampMeta{}, errInvalidID
	}
	return s.getMetaByKey(ctx, s.stampMetaKey(uid, id))
}

func (s *S3Store) getMetaByKey(ctx context.Context, key string) (StampMeta, error) {
	obj, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		if isNotFound(err) {
			return StampMeta{}, ErrStampNotFound
		}
		return StampMeta{}, err
	}
	defer obj.Body.Close()
	data, err := io.ReadAll(obj.Body)
	if err != nil {
		return StampMeta{}, err
	}
	var meta StampMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return StampMeta{}, err
	}
	return meta, nil
}

func (s *S3Store) SetStampName(ctx context.Context, uid, id, name string) (StampMeta, error) {
	if !safeSegment(uid) || !safeSegment(id) {
		return StampMeta{}, errInvalidID
	}
	unlock := s.locks.lock(uid)
	defer unlock()
	meta, err := s.StampMeta(ctx, uid, id)
	if err != nil {
		return StampMeta{}, err
	}
	meta.Name = name
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		return StampMeta{}, err
	}
	if err := s.putObject(ctx, s.stampMetaKey(uid, id), "application/json", metaBytes); err != nil {
		return StampMeta{}, err
	}
	return meta, nil
}

func (s *S3Store) DeleteStamp(ctx context.Context, uid, id string) error {
	if !safeSegment(uid) || !safeSegment(id) {
		return errInvalidID
	}
	for _, key := range []string{s.stampKey(uid, id), s.stampMetaKey(uid, id)} {
		if _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(s.bucket),
			Key:    aws.String(key),
		}); err != nil && !isNotFound(err) {
			return err
		}
	}
	return nil
}

func (s *S3Store) GetLibrary(ctx context.Context, uid string) (Library, error) {
	if !safeSegment(uid) {
		return Library{}, errInvalidID
	}
	obj, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.libraryKey(uid)),
	})
	if err != nil {
		if isNotFound(err) {
			return Library{}, nil
		}
		return Library{}, err
	}
	defer obj.Body.Close()
	data, err := io.ReadAll(obj.Body)
	if err != nil {
		return Library{}, err
	}
	var lib Library
	if err := json.Unmarshal(data, &lib); err != nil {
		return Library{}, err
	}
	return lib, nil
}

func (s *S3Store) PutLibrary(ctx context.Context, uid string, next Library) (Library, error) {
	if !safeSegment(uid) {
		return Library{}, errInvalidID
	}
	unlock := s.locks.lock(uid)
	defer unlock()
	current, err := s.GetLibrary(ctx, uid)
	if err != nil {
		return Library{}, err
	}
	if next.Version != current.Version {
		return Library{}, ErrVersionConflict
	}
	stored := Library{Version: current.Version + 1, Data: next.Data}
	data, err := json.Marshal(stored)
	if err != nil {
		return Library{}, err
	}
	if err := s.putObject(ctx, s.libraryKey(uid), "application/json", data); err != nil {
		return Library{}, err
	}
	return stored, nil
}

// PurgeUser deletes every object under the user's key prefix (stamps + the
// settings document), in batches of up to 1000.
func (s *S3Store) PurgeUser(ctx context.Context, uid string) error {
	if !safeSegment(uid) {
		return errInvalidID
	}
	unlock := s.locks.lock(uid)
	defer unlock()
	prefix := s.key(uid) + "/"
	paginator := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{
		Bucket: aws.String(s.bucket),
		Prefix: aws.String(prefix),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return err
		}
		if len(page.Contents) == 0 {
			continue
		}
		objects := make([]s3types.ObjectIdentifier, 0, len(page.Contents))
		for _, obj := range page.Contents {
			objects = append(objects, s3types.ObjectIdentifier{Key: obj.Key})
		}
		if _, err := s.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(s.bucket),
			Delete: &s3types.Delete{Objects: objects, Quiet: aws.Bool(true)},
		}); err != nil {
			return err
		}
	}
	return nil
}

// isNotFound reports whether err is an S3 "object does not exist" error.
func isNotFound(err error) bool {
	var nsk *s3types.NoSuchKey
	if errors.As(err, &nsk) {
		return true
	}
	var nf *s3types.NotFound
	if errors.As(err, &nf) {
		return true
	}
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.ErrorCode() {
		case "NoSuchKey", "NotFound", "404":
			return true
		}
	}
	return false
}
