<div dir="rtl" align="right">

# Qurp

کورپ یک کلاینت پروکسی برای **GNOME Shell** که داخل پنل Quick Settings لینوکس قرار می‌گیره و روی
[sing-box](https://sing-box.sagernet.org/) کار می‌کنه. اشتراکت رو اضافه کن، سرور رو انتخاب کن و وصل شو.

> [English](README.md) | فارسی

![Qurp panel, overview](<Screenshot From 2026-10-11 06-39-31.png>)
![Qurp panel, one subscription open](<Screenshot From 2026-10-11 06-37-13.png>)
![When the qurp connected! ](<Screenshot From 2026-10-11 06-39-12.png>)

## امکانات

- **پروتکل‌ها:** VLESS (‏TCP، WebSocket، gRPC، HTTP/2، HTTPUpgrade؛ با TLS و Reality)، VMess، Trojan، Shadowsocks، Hysteria2.
- **اشتراک‌ها:** لیست لینک، base64 (از جمله URL-safe) و sing-box JSON؛ آپدیت خودکار؛ نمایش حجم و انقضا (اگر ارائه‌دهنده بفرسته)؛ افزودن گروهی.
- **دو حالت:** پروکسی سیستم (تنظیمات پروکسی GNOME) یا **TUN** (کل ترافیک).
- **کیل‌سوییچ** (با nftables): هر چیزی که بیرون تونل بره بسته می‌شه؛ در صورت خطا هم اتصال برقرار نمی‌شه.
- **مسیریابی:** لیست direct و block برای دامنه، رنج IP و برنامه‌ها، به‌علاوه‌ی پیش‌تنظیم `ir-bypass`.
- **تست سرور:** پینگ TCP یا تأخیر واقعی از طریق sing-box؛ اتصال به سریع‌ترین سرور؛ پین‌کردن سرورهای محبوب.
- **پایداری:** اتصال خودکار موقع ورود، اتصال مجدد خودکار (مرگ هسته، تونل خراب، تغییر شبکه).
- **حریم خصوصی:** محافظ نشت DNS (در TUN همیشه روشن)، DNS سفارشی، تکه‌تکه‌کردن TLS (اختیاری)، بررسی آی‌پی خروجی. دامنه‌های مقصد به‌صورت پیش‌فرض داخل لاگ **نوشته نمی‌شن**.
- **پنل:** داخل Quick Settings قرار می‌گیره؛ جای تایلش (پیش‌فرض زیر Wi-Fi، یا هر خونه‌ای) رو از *Settings ← General* انتخاب کن. اشتراک‌ها یکی‌یکی باز می‌شن و لیست سرورها با اندازه‌ی صفحه جور می‌شه.
- **آپدیت:** چیپ نسخه داخل پنل وقتی ریلیز جدیدتری روی گیت‌هاب باشه قرمز می‌شه (تقریباً دو بار در روز چک می‌شه).
- **زبان‌ها:** انگلیسی، فارسی (با چیدمان راست‌به‌چپ) و چینی.

## پیش‌نیازها

| مورد | برای چی |
|---|---|
| GNOME Shell نسخه‌ی ۴۶ تا ۵۰ (۴۹ و ۵۰: بخش «سازگاری») | همه‌چیز |
| [sing-box](https://sing-box.sagernet.org/installation/) نسخه‌ی **۱.۱۲ یا بالاتر** داخل `PATH` (installer می‌تونه دانلودش کنه) | همه‌چیز |
| `nftables` و `polkit` ‏(`pkexec`) | کیل‌سوییچ |
| ابزارهای `libcap` ‏(`setcap` و `getcap`) | حالت TUN |

Qurp خودش sing-box رو همراهش نداره. ساده‌ترین راه اینه که بذاری installer ریلیز رسمی رو برات دانلود کنه (`./install.sh --install-core`، بخش «نصب»). می‌تونی از مخزن توزیعت یا دستی هم نصبش کنی؛ با `sing-box version` چک کن.

### نصب دستی sing-box (هر توزیعی، از جمله Fedora)

اگه توزیعت پکیجش رو نداره، باینری رسمی ریلیز رو نصب کن (روی ARM به‌جای `linux-amd64` از `linux-arm64` استفاده کن؛ آخرین نسخه رو از [صفحه‌ی ریلیزها](https://github.com/SagerNet/sing-box/releases) ببین):

```bash
VER=1.14.2
curl -LO https://github.com/SagerNet/sing-box/releases/download/v$VER/sing-box-$VER-linux-amd64.tar.gz
tar xzf sing-box-$VER-linux-amd64.tar.gz
sudo install -m 0755 sing-box-$VER-linux-amd64/sing-box /usr/local/bin/sing-box
sudo restorecon -v /usr/local/bin/sing-box     # فقط روی سیستم‌های SELinux مثل Fedora لازمه
sing-box version
```

Qurp اول `PATH` شل و بعد `/usr/local/bin`، `/usr/bin`، `~/.local/bin`، `~/go/bin` و `~/bin` رو برای `sing-box` می‌گرده. بعد از نصب یک‌بار خروج و ورود بزن.

## نصب

```bash
git clone https://github.com/1xpwn/qurp.git
cd qurp
./install.sh                # نصب اکستنشن (اول سیستمت رو چک می‌کنه)
./install.sh --install-core # همون، و اگه sing-box نبود دانلود و نصبش می‌کنه
./install.sh --check        # فقط سیستمت رو چک می‌کنه، چیزی عوض نمی‌کنه
```

installer مرحله‌به‌مرحله کار می‌کنه و می‌گه چی پیدا کرده: نسخه‌ی GNOME Shell، sing-box (و نسخه‌اش)، ابزارهای اختیاری، و بعد چیزهایی که نصب کرده. آخرش **قدم‌های بعدی** رو چاپ می‌کنه و اگه چیزی کم باشه، یه بلوک **ACTION REQUIRED** با راه‌حل دقیق نشون می‌ده. قبل از هر دانلودی می‌پرسه (با `-y` جواب «بله» می‌ده). با کاربر عادی اجراش کن، نه با `sudo`؛ فقط جاهایی که لازمه خودش `sudo` می‌خواد.

بخش‌های اختیاری (`sudo` می‌خوان):

```bash
./install.sh --helper   # کیل‌سوییچ: هلپر و polkit policy نصب می‌شن
./install.sh --tun      # حالت TUN: کپی خصوصی sing-box با capabilityهای شبکه
./install.sh --all      # هر دو
```

بعد **GNOME Shell رو ری‌استارت کن** (Wayland: خروج و ورود دوباره؛ X11: ‏`Alt+F2`، بنویس `r` و Enter) و فعالش کن:

```bash
gnome-extensions enable qurp@gnome-shell-extension
```

### نصب دستی

```bash
DEST=~/.local/share/gnome-shell/extensions/qurp@gnome-shell-extension
mkdir -p "$DEST"
cp -r extension.js prefs.js metadata.json stylesheet.css schemas locales helper "$DEST"/
glib-compile-schemas "$DEST/schemas"
```

### حذف

```bash
./install.sh --uninstall
```

اکستنشن، هلپر، کپی خصوصی sing-box و قوانین باقی‌مانده‌ی کیل‌سوییچ رو پاک می‌کنه. تنظیمات و لاگ داخل `~/.config/qurp` می‌مونن؛ اگه می‌خوای پاک بشن اون پوشه رو دستی حذف کن.

## استفاده

۱. روی **Qurp** داخل Quick Settings کلیک کن (لیست سرورها هم داخل همون پنله).
۲. **Settings** رو باز کن و توی صفحه‌ی *Subscriptions* لینک اشتراکت رو اضافه کن (یا با *Bulk add* چند لینک رو یک‌جا بچسبون).
۳. یه سرور رو انتخاب و وصل شو. قبلش با دکمه‌ی تست می‌تونی سرورها رو بسنجی.

### پروکسی سیستم یا TUN

*پروکسی سیستم* تنظیمات پروکسی GNOME رو عوض می‌کنه، پس فقط برنامه‌هایی رو پوشش می‌ده که ازش پیروی می‌کنن (مرورگرها معمولاً می‌کنن). *TUN* کل ترافیک رو از یه اینترفیس مجازی رد می‌کنه و `./install.sh --tun` لازم داره. تنظیمات پروکسی خودت موقع اتصال ذخیره و موقع قطع برگردونده می‌شه.

### کیل‌سوییچ

`./install.sh --helper` لازم داره و از *Settings ← Advanced* روشنش می‌کنی. وقتی وصلی، فقط تونل، آدرس سرور، رنج‌های محلی و DHCP اجازه‌ی خروج دارن؛ DNS ساده و DNS-over-TLS (پورت‌های ۵۳ و ۸۵۳) بیرون تونل بسته می‌شن. موقع اعمال قوانین، تأیید هویت از طریق polkit خواسته می‌شه.

نکته‌ها:

- وقتی کیل‌سوییچ **روشنه**، قوانین direct بر اساس دامنه و برنامه (از جمله `ir-bypass`) اعمال نمی‌شن، چون ترافیک direct بسته می‌شد. رنج‌های IP مستقیم مجازن. پنل بهت می‌گه.
- اگه شل وسط فعال‌بودن کیل‌سوییچ کرش کنه، Qurp دفعه‌ی بعد حالت *blocked* رو با یه دکمه‌ی آزادسازی نشون می‌ده. برای حذف دستی قوانین: `sudo nft delete table inet qurp_ks`.
- وقتی کیل‌سوییچ روشنه، سرورهای دیگه رو نمی‌شه تست کرد.

## حریم خصوصی و دسترسی شبکه

Qurp تلمتری نداره. فقط به این‌ها وصل می‌شه:

- **لینک اشتراک‌هات**؛
- `www.gstatic.com/generate_204` **از داخل تونل** برای سنجش تأخیر سرور وصل‌شده؛
- `api.ipify.org`، `ipv4.icanhazip.com`، `checkip.amazonaws.com`، `ifconfig.me` **از داخل تونل** وقتی آی‌پی خروجی رو چک می‌کنی؛
- **API گیت‌هاب** (تقریباً دو بار در روز) برای پیدا کردن نسخه‌ی جدید. از *Settings ← Advanced ← Check for new releases* خاموشش کن.

فایل‌های محلی داخل `~/.config/qurp/` هستن (کش اشتراک‌ها، مصرف، `client.log`) و با دسترسی فقط‌برای‌صاحب ساخته می‌شن. لینک اشتراک و لینک سرورها اطلاعات ورود دارن؛ این فایل‌ها و لاگ رو با کسی به اشتراک نذار. سطح لاگ هسته `warn` ئه؛ گزینه‌ی *Verbose core log* هر دامنه‌ی مقصد رو روی دیسک می‌نویسه، پس جز برای دیباگ خاموشش بذار.

## عیب‌یابی

| مشکل | کار |
|---|---|
| «sing-box is not installed» (توی لاگ: `core_missing`) | `./install.sh --install-core` رو بزن (یا دستی نصبش کن: بخش «نصب دستی sing-box»)، بعد خروج و ورود. خط لاگ می‌گه چیکار کنی و `PATH`ای که شل گشته رو نشون می‌ده. |
| «sing-box could not be started» | فایل هست ولی اجرا نمی‌شه: `ls -l $(command -v sing-box)`، معماری (`file`) و SELinux (‏`sudo ausearch -m avc -ts recent`) رو چک کن. |
| «sing-box is too old» | `./install.sh --install-core` رو بزن تا آخرین ریلیز نصب بشه (Qurp نسخه‌ی ۱.۱۲ یا بالاتر می‌خواد). |
| «The local proxy port is already in use» | پورت رو در *Settings ← Advanced* عوض کن. |
| بعد از کرش اینترنت قطعه | حالت *blocked* رو از پنل آزاد کن یا `sudo nft delete table inet qurp_ks` بزن. |
| پروکسی GNOME بعد از کرش مونده | Qurp دفعه‌ی بعد برش می‌گردونه؛ یا `gsettings set org.gnome.system.proxy mode 'none'` بزن. |
| TUN شروع نمی‌شه | دوباره `./install.sh --tun` بزن (بعد از هر آپدیت sing-box). |
| لاگ‌ها | *Settings ← Logs* یا `~/.config/qurp/client.log`؛ خطاهای شل: `journalctl --user -g qurp`. |

## سازگاری

- GNOME Shell نسخه‌ی ۴۶، ۴۷، ۴۸: پشتیبانی می‌شه.
- نسخه‌های ۴۹ و ۵۰ داخل `metadata.json` هستن ولی کم تست شدن؛ مشکلی دیدی خبر بده.
- تست‌شده روی: فدورا و اوبونتو.

## محدودیت‌ها

- sing-box ترنسپورت‌های **xhttp**، **kcp** و **quic** رو پشتیبانی نمی‌کنه؛ این لینک‌ها نشون داده می‌شن ولی علامت می‌خورن و وصل نمی‌شن.
- اشتراک **Clash YAML** پشتیبانی نمی‌شه (از لینک ساده یا sing-box JSON استفاده کن).
- «اتصال به سریع‌ترین سرور» از پروب TCP یا تأخیر واقعی استفاده می‌کنه که پشت CDN ممکنه شبیه هم دیده بشن.


## سلب مسئولیت

Qurp یک ابزار شبکه‌ی عمومیه. مسئولیت استفاده طبق قوانین محل زندگی‌ات و شرایط سرویس‌دهنده‌هات با خودته. بدون هیچ ضمانتی و «همان‌طور که هست» ارائه می‌شه.

## مجوز

[GPL-3.0-only](LICENSE). حق نشر (C) ۲۰۲۶ MNM.

sing-box پروژه‌ی جداست و مجوز خودش رو داره؛ بخشی از این مخزن نیست.


## اگر خوشت اومد راجبش توییت بزن

</div>