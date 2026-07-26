package auth

import (
	"context"
	"testing"
)

// 游客持会话走第三方登录:首次出现的身份就地升级游客(uid 不变,库随之保留),
// 与密码注册的升级语义一致。
func TestExternalClaimUpgradesGuestInPlace(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	settings := AuthSettings{RegisterEnabled: true, ThirdPartyRegisterEnabled: true}

	guest, _, _, err := svc.CreateGuest(ctx, "1.2.3.4")
	if err != nil {
		t.Fatal(err)
	}
	ident := ExternalIdentity{Provider: "email", Subject: "user@example.com", DisplayName: "user"}
	user, token, _, err := svc.LoginOrRegisterExternalClaiming(ctx, ident, settings, guest.ID)
	if err != nil {
		t.Fatal(err)
	}
	if user.ID != guest.ID {
		t.Fatalf("claim should keep guest uid: got %q want %q", user.ID, guest.ID)
	}
	if user.IsGuest {
		t.Fatal("claimed user should no longer be a guest")
	}
	if token == "" {
		t.Fatal("expected a session token")
	}

	// 同一身份再次登录进入同一账号;旁观的另一个游客不能吞并它。
	other, _, _, err := svc.CreateGuest(ctx, "1.2.3.4")
	if err != nil {
		t.Fatal(err)
	}
	again, _, _, err := svc.LoginOrRegisterExternalClaiming(ctx, ident, settings, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != guest.ID {
		t.Fatalf("returning identity should log into the claimed account, got %q", again.ID)
	}
	otherNow, err := svc.db.UserByID(ctx, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !otherNow.IsGuest {
		t.Fatal("second guest must stay a guest when the identity already maps to an account")
	}
}

// claimUID 不是可升级游客(乱传/已被清扫)时退回常规开号,不报错。
func TestExternalClaimFallsBackWhenNotGuest(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	settings := AuthSettings{RegisterEnabled: true, ThirdPartyRegisterEnabled: true}
	user, _, _, err := svc.LoginOrRegisterExternalClaiming(ctx,
		ExternalIdentity{Provider: "github", Subject: "42", DisplayName: "dev"}, settings, "deadbeefdeadbeefdeadbeefdeadbeef")
	if err != nil {
		t.Fatal(err)
	}
	if user.ID == "" || user.IsGuest {
		t.Fatalf("expected a fresh non-guest account, got %#v", user)
	}
}

// 邀请制实例不做游客转正:走常规开号路径给出一致的邀请码错误。
func TestExternalClaimHonorsInviteRequirement(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	settings := AuthSettings{RegisterEnabled: true, ThirdPartyRegisterEnabled: true, InviteRequired: true}
	guest, _, _, err := svc.CreateGuest(ctx, "1.2.3.4")
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, err = svc.LoginOrRegisterExternalClaiming(ctx,
		ExternalIdentity{Provider: "email", Subject: "x@y.com", DisplayName: "x"}, settings, guest.ID)
	if err == nil {
		t.Fatal("invite-required instance must not silently claim a guest")
	}
	// 游客保持原样,没有被半升级。
	guestNow, dbErr := svc.db.UserByID(ctx, guest.ID)
	if dbErr != nil {
		t.Fatal(dbErr)
	}
	if !guestNow.IsGuest {
		t.Fatal("guest must remain untouched when registration gates reject the claim")
	}
}
