import express from "express";
import bodyParser from "body-parser";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import pkg from "lknpd-nalog-api";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const { NalogApi } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 4000;
const MAX_RETRIES = 3;
const ERROR_FILE = path.join(__dirname, "error.json");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

const nalogApi = new NalogApi({
  inn: process.env.INN,
  password: process.env.PASSWORD
});

async function createReceiptWithRetry(income, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await nalogApi.addIncome(income);
    } catch (err) {
      console.error(`Попытка ${attempt} не удалась`, err.message || err);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function saveToErrorFile(errorData) {
  try {
    let errors = [];
    
    try {
      const data = await fs.readFile(ERROR_FILE, "utf8");
      const parsedData = JSON.parse(data);
      if (Array.isArray(parsedData)) {
        errors = parsedData;
      }
    } catch (err) {
    }
    
    errors.push({
      ...errorData,
      timestamp: new Date().toISOString(),
      retryAttempt: 0
    });
    
    await fs.writeFile(ERROR_FILE, JSON.stringify(errors, null, 2));
    console.log(`Ошибка сохранена в ${ERROR_FILE}`);
  } catch (err) {
    console.error("Не удалось сохранить ошибку в файл:", err);
  }
}

async function notifyAdmin(errorData) {
  try {
    const html = `
<!DOCTYPE HTML>
<html>
<head>
<meta charset="utf-8">
<title>Ошибка создания чека</title>
</head>
<body>
<h2>⚠️ Ошибка при создании чека</h2>
<p><b>Время:</b> ${new Date().toLocaleString()}</p>
<p><b>Email клиента:</b> ${errorData.email}</p>
<p><b>Сумма:</b> ${errorData.amount} ₽</p>
<p><b>Ошибка:</b> ${errorData.error}</p>
<p><b>Данные заказа:</b></p>
<pre>${JSON.stringify(errorData.items, null, 2)}</pre>
<p>Ошибка сохранена в error.json для последующей обработки.</p>
<p>Пробейте чек вручную через приложение Мой налог и вручную отправте клиенту чек по email.</p>
</body>
</html>
`;

    await transporter.sendMail({
      from: process.env.SMTP_MAIL_FROM,
      to: ADMIN_EMAIL,
      subject: `Ошибка создания чека ${process.env.APPNAME}`,
      html
    });
    
    console.log(`Администратор ${ADMIN_EMAIL} уведомлен об ошибке`);
  } catch (err) {
    console.error("Не удалось отправить уведомление администратору:", err);
  }
}

app.get("/health", async (req, res) => {
  const result = {
    status: "ok",
    connect_to_fns: "ok",
    smtp: "ok",
  };

  try {
    await transporter.verify();
  } catch (err) {
    result.smtp = "error";
    result.status = "degraded";
  }

  try {
    await nalogApi.getUserInfo();
  } catch (err) {
    console.error("FNS health error:", err.message || err);
    result.connect_to_fns = "error";
    result.status = "degraded";
  }

  res.json(result);
});

app.post("/api/v1/create-receipt", async (req, res) => {
  try {
    const { api_pass, email, items } = req.body;

    if (api_pass !== process.env.API_PASS) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!email || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Неверные данные" });
    }

    const total = items.reduce(
      (sum, i) => sum + i.price * (i.quantity || 1),
      0
    );

    const income = {
      name: `${process.env.APPNAME}`,
      amount: Number(total.toFixed(2)),
      quantity: 1
    };

    const receiptId = await createReceiptWithRetry(income);

    const printLink = `https://lknpd.nalog.ru/api/v1/receipt/${process.env.INN}/${receiptId}/print`;

    const rows = items.map(i => {
      const qty = i.quantity || 1;
      return `
        <tr>
          <td>${i.id}</td>
          <td>${i.name}</td>
          <td>${i.price.toFixed(2)}</td>
          <td>${qty}</td>
          <td>${(i.price * qty).toFixed(2)}</td>
        </tr>
      `;
    }).join("");

    const html = `
<!DOCTYPE HTML>
<html>
<head>
<meta charset="utf-8">
<title>Чек</title>
<link rel="stylesheet" href="https://cdn.email.ga1maz.ru/emails/styles.css">
</head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;color:#333;background:#f5f6f7;">
<table width="100%" bgcolor="#f5f6f7">
<tr>
<td align="center">
<table width="600" bgcolor="#ffffff" style="margin:40px auto;">
<tr>
<td style="padding:24px;text-align:center;color:#333;">
<img src="https://cdn.email.ga1maz.ru/emails/main.png" width="536" />
<h2 style="color:#333;">Ваш чек</h2>
<p style="color:#333;">Чек сформирован в ФНС (Мой налог)</p>

<table width="100%" border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;color:#333;">
<tr style="background:#eee;">
<th>ID</th><th>Название</th><th>Цена</th><th>Кол-во</th><th>Сумма</th>
</tr>
${rows}
</table>

<p><b>Итого:</b> ${total.toFixed(2)} ₽</p>

<a href="${printLink}" target="_blank"
style="display:inline-block;background:#ffdd2d;padding:16px 36px;border-radius:4px;color:#333;text-decoration:none;">
Посмотреть чек
</a>

<p style="font-size:12px;color:#999;margin-top:24px;">
${process.env.APPNAME}
</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
`;

    await transporter.sendMail({
      from: process.env.SMTP_MAIL_FROM,
      to: email,
      subject: `Чек ${process.env.APPNAME}`,
      html
    });

    res.json({
      success: true,
      receiptId,
      printLink
    });

  } catch (err) {
    console.error("Ошибка создания чека:", err);
    
    const errorData = {
      email: req.body.email,
      items: req.body.items,
      amount: req.body.items.reduce((sum, i) => sum + i.price * (i.quantity || 1), 0),
      error: err.message || "Неизвестная ошибка",
      api_pass: req.body.api_pass
    };
    
    await saveToErrorFile(errorData);
    await notifyAdmin(errorData);
    
    res.status(500).json({ 
      error: "Не удалось создать чек. Данные сохранены для повторной попытки.",
      saved_to_error_file: true
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
  console.log(`📁 Файл ошибок: ${ERROR_FILE}`);
});