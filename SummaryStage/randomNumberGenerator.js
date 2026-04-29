/**
 * 随机数生成器
 * 提供多种随机数生成功能
 */

class RandomNumberGenerator {
    /**
     * 生成指定范围内的随机整数
     * @param {number} min - 最小值（包含）
     * @param {number} max - 最大值（包含）
     * @returns {number} 随机整数
     */
    static getRandomInt(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    /**
     * 生成指定范围内的随机浮点数
     * @param {number} min - 最小值（包含）
     * @param {number} max - 最大值（不包含）
     * @param {number} precision - 小数点精度（可选，默认为2）
     * @returns {number} 随机浮点数
     */
    static getRandomFloat(min, max, precision = 2) {
        const random = Math.random() * (max - min) + min;
        return parseFloat(random.toFixed(precision));
    }

    /**
     * 生成随机布尔值
     * @returns {boolean} 随机布尔值
     */
    static getRandomBoolean() {
        return Math.random() >= 0.5;
    }

    /**
     * 从数组中随机选择一个元素
     * @param {Array} array - 输入数组
     * @returns {*} 随机选择的元素
     */
    static getRandomElement(array) {
        if (!Array.isArray(array) || array.length === 0) {
            throw new Error('输入必须是非空数组');
        }
        const index = Math.floor(Math.random() * array.length);
        return array[index];
    }

    /**
     * 生成指定长度的随机字符串
     * @param {number} length - 字符串长度
     * @param {string} charset - 字符集（可选）
     * 可选项：'numeric', 'alpha', 'alphanumeric', 'hex', 'custom'
     * @param {string} customChars - 自定义字符集（当charset为'custom'时使用）
     * @returns {string} 随机字符串
     */
    static getRandomString(length = 10, charset = 'alphanumeric', customChars = '') {
        let chars;
        
        switch(charset) {
            case 'numeric':
                chars = '0123456789';
                break;
            case 'alpha':
                chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
                break;
            case 'alphanumeric':
                chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                break;
            case 'hex':
                chars = '0123456789abcdef';
                break;
            case 'custom':
                if (!customChars) {
                    throw new Error('使用custom字符集时必须提供customChars参数');
                }
                chars = customChars;
                break;
            default:
                throw new Error(`不支持的字符集: ${charset}`);
        }

        let result = '';
        const charsLength = chars.length;
        
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * charsLength));
        }
        
        return result;
    }

    /**
     * 生成随机颜色（十六进制格式）
     * @returns {string} 十六进制颜色代码
     */
    static getRandomColor() {
        return '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
    }

    /**
     * 生成随机RGB颜色
     * @returns {Object} RGB颜色对象
     */
    static getRandomRGB() {
        return {
            r: this.getRandomInt(0, 255),
            g: this.getRandomInt(0, 255),
            b: this.getRandomInt(0, 255)
        };
    }

    /**
     * 生成随机RGBA颜色
     * @param {number} alpha - 透明度（0-1）
     * @returns {Object} RGBA颜色对象
     */
    static getRandomRGBA(alpha = 1) {
        return {
            r: this.getRandomInt(0, 255),
            g: this.getRandomInt(0, 255),
            b: this.getRandomInt(0, 255),
            a: alpha
        };
    }

    /**
     * 生成随机日期
     * @param {Date} start - 开始日期（可选）
     * @param {Date} end - 结束日期（可选）
     * @returns {Date} 随机日期
     */
    static getRandomDate(start = new Date(2000, 0, 1), end = new Date()) {
        return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
    }

    /**
     * 生成指定长度的随机数组
     * @param {number} length - 数组长度
     * @param {Function} generator - 元素生成函数（可选）
     * @returns {Array} 随机数组
     */
    static getRandomArray(length = 10, generator = () => Math.random()) {
        const array = [];
        for (let i = 0; i < length; i++) {
            array.push(generator());
        }
        return array;
    }

    /**
     * 打乱数组（Fisher-Yates洗牌算法）
     * @param {Array} array - 输入数组
     * @returns {Array} 打乱后的数组
     */
    static shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    /**
     * 生成满足正态分布的随机数
     * @param {number} mean - 平均值
     * @param {number} stdDev - 标准差
     * @returns {number} 正态分布随机数
     */
    static getNormalRandom(mean = 0, stdDev = 1) {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        const normal = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        return normal * stdDev + mean;
    }

    /**
     * 生成UUID（版本4）
     * @returns {string} UUID字符串
     */
    static getUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * 生成随机密码
     * @param {number} length - 密码长度（默认12）
     * @param {Object} options - 选项
     * @param {boolean} options.includeUppercase - 包含大写字母
     * @param {boolean} options.includeLowercase - 包含小写字母
     * @param {boolean} options.includeNumbers - 包含数字
     * @param {boolean} options.includeSymbols - 包含特殊符号
     * @returns {string} 随机密码
     */
    static getRandomPassword(length = 12, options = {}) {
        const {
            includeUppercase = true,
            includeLowercase = true,
            includeNumbers = true,
            includeSymbols = true
        } = options;

        const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const lowercase = 'abcdefghijklmnopqrstuvwxyz';
        const numbers = '0123456789';
        const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';

        let chars = '';
        if (includeUppercase) chars += uppercase;
        if (includeLowercase) chars += lowercase;
        if (includeNumbers) chars += numbers;
        if (includeSymbols) chars += symbols;

        if (!chars) {
            throw new Error('至少需要选择一种字符类型');
        }

        // 确保每种被选中的字符类型至少出现一次
        const password = [];
        if (includeUppercase) password.push(this.getRandomElement(uppercase.split('')));
        if (includeLowercase) password.push(this.getRandomElement(lowercase.split('')));
        if (includeNumbers) password.push(this.getRandomElement(numbers.split('')));
        if (includeSymbols) password.push(this.getRandomElement(symbols.split('')));

        // 填充剩余长度
        while (password.length < length) {
            password.push(this.getRandomElement(chars.split('')));
        }

        // 打乱数组
        return this.shuffleArray(password).join('');
    }
}

// 导出模块
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RandomNumberGenerator;
}

// 浏览器环境支持
if (typeof window !== 'undefined') {
    window.RandomNumberGenerator = RandomNumberGenerator;
}